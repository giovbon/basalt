package ntfy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"notediscovery/internal/config"

	"gopkg.in/yaml.v3"
)

const (
	maxEventSize      = 8 << 20
	maxAttachmentSize = 100 << 20
	maxCaptureState   = 64 << 20
	captureStateFile  = ".basalt-ntfy-state.json"
	captureStateVer   = 1
)

type Event struct {
	ID         string     `json:"id"`
	Time       int64      `json:"time"`
	Event      string     `json:"event"`
	Topic      string     `json:"topic"`
	Title      string     `json:"title"`
	Message    string     `json:"message"`
	Attachment Attachment `json:"attachment"`
}

type Attachment struct {
	Name string `json:"name"`
	Type string `json:"type"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

type Monitor struct {
	topic       string
	username    string
	password    string
	captureDir  string
	tags        []string
	streamURL   string
	serverURL   *url.URL
	client      *http.Client
	sourceKey   string
	statePath   string
	stateMu     sync.Mutex
	state       captureState
	stateLoaded bool
}

type captureState struct {
	Version int                           `json:"version"`
	Sources map[string]captureSourceState `json:"sources"`
}

type captureSourceState struct {
	IgnoreBefore int64           `json:"ignore_before"`
	Seen         map[string]bool `json:"seen"`
}

func NewMonitor(cfg config.NtfyConfig, notesDir string) (*Monitor, error) {
	serverURL, err := url.Parse(strings.TrimRight(strings.TrimSpace(cfg.ServerURL), "/"))
	if err != nil || (serverURL.Scheme != "http" && serverURL.Scheme != "https") || serverURL.Host == "" ||
		serverURL.User != nil || serverURL.RawQuery != "" || serverURL.Fragment != "" {
		return nil, fmt.Errorf("invalid ntfy server_url")
	}
	if cfg.Topic == "" || strings.ContainsAny(cfg.Topic, "/?#") || cfg.Topic == "." || cfg.Topic == ".." {
		return nil, fmt.Errorf("invalid ntfy topic")
	}
	if (cfg.Username == "") != (cfg.Password == "") {
		return nil, fmt.Errorf("ntfy username and password must both be configured")
	}
	if cfg.CaptureDir == "" || filepath.IsAbs(cfg.CaptureDir) {
		return nil, fmt.Errorf("ntfy capture_dir must be a non-empty relative path")
	}
	tags := config.NormalizeNtfyTags(cfg.Tags)
	if len(tags) == 0 {
		tags = []string{"ntfy"}
	}
	captureDir := filepath.Clean(cfg.CaptureDir)
	if captureDir == ".." || strings.HasPrefix(captureDir, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("ntfy capture_dir must stay inside the notes directory")
	}

	basePath := strings.TrimRight(serverURL.Path, "/")
	serverURL.Path = basePath
	streamURL := *serverURL
	streamURL.Path = basePath + "/" + cfg.Topic + "/json"
	streamURL.RawPath = ""

	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			if !sameOrigin(serverURL, req.URL) {
				return errors.New("ntfy redirect changed origin")
			}
			return nil
		},
	}

	return &Monitor{
		topic:      cfg.Topic,
		username:   cfg.Username,
		password:   cfg.Password,
		captureDir: filepath.Join(notesDir, captureDir),
		tags:       tags,
		streamURL:  streamURL.String(),
		serverURL:  serverURL,
		client:     client,
		sourceKey:  serverURL.String() + "\x00" + cfg.Topic,
		statePath:  filepath.Join(notesDir, captureStateFile),
	}, nil
}

func (m *Monitor) Run(ctx context.Context) error {
	if err := os.MkdirAll(m.captureDir, 0755); err != nil {
		return fmt.Errorf("creating ntfy capture directory %q: %w", m.captureDir, err)
	}

	backoff := time.Second
	for {
		err := m.listen(ctx)
		if ctx.Err() != nil {
			return nil
		}
		log.Printf("ntfy monitor for topic %q disconnected: %v; reconnecting in %s", m.topic, err, backoff)

		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func (m *Monitor) listen(ctx context.Context) error {
	if err := m.loadCaptureState(); err != nil {
		return fmt.Errorf("loading ntfy capture state: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.streamURL, nil)
	if err != nil {
		return fmt.Errorf("building ntfy request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if m.username != "" {
		req.SetBasicAuth(m.username, m.password)
	}
	query := req.URL.Query()
	query.Set("since", "all")
	req.URL.RawQuery = query.Encode()

	resp, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("connecting to ntfy: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("ntfy returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), maxEventSize)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var event Event
		if err := json.Unmarshal(line, &event); err != nil {
			log.Printf("ntfy monitor received an invalid event: %v", err)
			continue
		}
		if event.Event != "message" {
			continue
		}
		m.stateMu.Lock()
		source := m.state.Sources[m.sourceKey]
		ignore := event.Time > 0 && event.Time < source.IgnoreBefore
		m.stateMu.Unlock()
		if ignore {
			continue
		}
		if err := m.captureEvent(ctx, event); err != nil {
			log.Printf("ntfy monitor could not capture message %q: %v", event.ID, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("reading ntfy stream: %w", err)
	}
	return io.EOF
}

func (m *Monitor) captureEvent(ctx context.Context, event Event) error {
	if err := m.loadCaptureState(); err != nil {
		return fmt.Errorf("loading ntfy capture state: %w", err)
	}
	m.stateMu.Lock()
	defer m.stateMu.Unlock()

	source := m.state.Sources[m.sourceKey]
	eventKey := captureEventKey(event)
	if source.Seen[eventKey] {
		return nil
	}

	if err := os.MkdirAll(m.captureDir, 0755); err != nil {
		return fmt.Errorf("creating capture directory: %w", err)
	}

	stamp := time.Now().UTC()
	if event.Time > 0 {
		stamp = time.Unix(event.Time, 0).UTC()
	}
	id := safeName(event.ID)
	if id == "" {
		id = strconv.FormatInt(stamp.Unix(), 10)
	}
	prefix := stamp.Format("20060102-150405") + "-" + id
	notePath := filepath.Join(m.captureDir, prefix+".md")
	if _, err := os.Stat(notePath); err == nil {
		return m.markCaptured(source, eventKey)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("checking existing capture note: %w", err)
	}

	attachmentName := ""
	if event.Attachment.URL != "" {
		name, err := m.downloadAttachment(ctx, event.Attachment, prefix)
		if err != nil {
			return fmt.Errorf("downloading attachment: %w", err)
		}
		attachmentName = name
	}

	title := strings.TrimSpace(event.Title)
	if title == "" {
		title = "Captura ntfy"
	}
	var note strings.Builder
	frontmatter, err := yaml.Marshal(struct {
		Tags []string `yaml:"tags"`
	}{Tags: m.tags})
	if err != nil {
		return fmt.Errorf("encoding capture tags: %w", err)
	}
	note.WriteString("---\n")
	note.Write(frontmatter)
	note.WriteString("---\n\n")
	fmt.Fprintf(&note, "# %s\n\n", title)
	fmt.Fprintf(&note, "Capturado em %s UTC do tópico `%s`.\n", stamp.UTC().Format("02/01/2006 às 15:04"), event.Topic)
	if message := strings.TrimSpace(event.Message); message != "" {
		note.WriteString("\n")
		note.WriteString(message)
		note.WriteString("\n")
	}
	if attachmentName != "" {
		note.WriteString("\n")
		if strings.HasPrefix(strings.ToLower(event.Attachment.Type), "image/") {
			fmt.Fprintf(&note, "![[%s]]\n", attachmentName)
		} else {
			fmt.Fprintf(&note, "[[%s]]\n", attachmentName)
		}
	}
	if err := writeAtomic(notePath, strings.NewReader(note.String()), maxEventSize); err != nil {
		return fmt.Errorf("saving capture note: %w", err)
	}
	return m.markCaptured(source, eventKey)
}

func captureEventKey(event Event) string {
	if event.ID != "" {
		return event.ID
	}
	return "time:" + strconv.FormatInt(event.Time, 10)
}

func (m *Monitor) loadCaptureState() error {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	if m.stateLoaded {
		return nil
	}

	data, err := os.ReadFile(m.statePath)
	shouldSave := false
	switch {
	case errors.Is(err, os.ErrNotExist):
		m.state = captureState{
			Version: captureStateVer,
			Sources: make(map[string]captureSourceState),
		}
		shouldSave = true
	case err != nil:
		return err
	default:
		if err := json.Unmarshal(data, &m.state); err != nil {
			return fmt.Errorf("decoding state file: %w", err)
		}
		if m.state.Version != captureStateVer || m.state.Sources == nil {
			return fmt.Errorf("unsupported or invalid state file version %d", m.state.Version)
		}
	}

	if m.state.Sources == nil {
		m.state.Sources = make(map[string]captureSourceState)
		shouldSave = true
	}
	source, exists := m.state.Sources[m.sourceKey]
	if !exists {
		source = captureSourceState{
			IgnoreBefore: time.Now().Unix(),
			Seen:         make(map[string]bool),
		}
		shouldSave = true
	} else if source.Seen == nil || source.IgnoreBefore <= 0 {
		return fmt.Errorf("invalid state for ntfy topic %q", m.topic)
	}
	m.state.Sources[m.sourceKey] = source
	if shouldSave {
		if err := m.saveCaptureStateLocked(); err != nil {
			return err
		}
	}
	m.stateLoaded = true
	return nil
}

func (m *Monitor) markCaptured(source captureSourceState, eventKey string) error {
	source.Seen[eventKey] = true
	m.state.Sources[m.sourceKey] = source
	return m.saveCaptureStateLocked()
}

func (m *Monitor) saveCaptureStateLocked() error {
	data, err := json.Marshal(m.state)
	if err != nil {
		return fmt.Errorf("encoding state file: %w", err)
	}
	if err := writeAtomic(m.statePath, bytes.NewReader(data), maxCaptureState); err != nil {
		return fmt.Errorf("saving state file: %w", err)
	}
	return nil
}

func (m *Monitor) downloadAttachment(ctx context.Context, attachment Attachment, prefix string) (string, error) {
	attachmentURL, err := url.Parse(attachment.URL)
	if err != nil || !sameOrigin(m.serverURL, attachmentURL) || attachmentURL.User != nil {
		return "", fmt.Errorf("attachment URL is not on the configured ntfy server")
	}
	if attachment.Size > maxAttachmentSize {
		return "", fmt.Errorf("attachment exceeds %d MiB", maxAttachmentSize>>20)
	}
	name := safeName(filepath.Base(strings.ReplaceAll(attachment.Name, "\\", "/")))
	if name == "" || name == "." {
		name = "attachment"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, attachmentURL.String(), nil)
	if err != nil {
		return "", fmt.Errorf("building attachment request: %w", err)
	}
	if m.username != "" {
		req.SetBasicAuth(m.username, m.password)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("requesting attachment: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("attachment returned HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > maxAttachmentSize {
		return "", fmt.Errorf("attachment exceeds %d MiB", maxAttachmentSize>>20)
	}

	safeTarget := filepath.Join(m.captureDir, prefix+"-"+name)
	if err := writeAtomic(safeTarget, resp.Body, maxAttachmentSize); err != nil {
		return "", fmt.Errorf("saving attachment: %w", err)
	}
	return filepath.Base(safeTarget), nil
}

func writeAtomic(path string, src io.Reader, limit int64) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".ntfy-capture-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	written, copyErr := io.Copy(tmp, io.LimitReader(src, limit+1))
	if copyErr == nil && written > limit {
		copyErr = fmt.Errorf("content exceeds %d bytes", limit)
	}
	if copyErr != nil {
		_ = tmp.Close()
		return copyErr
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func sameOrigin(a, b *url.URL) bool {
	return a != nil && b != nil &&
		strings.EqualFold(a.Scheme, b.Scheme) &&
		strings.EqualFold(a.Host, b.Host)
}

func safeName(value string) string {
	var out strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-', r == ' ':
			out.WriteRune(r)
		default:
			out.WriteByte('_')
		}
		if out.Len() >= 120 {
			break
		}
	}
	return strings.Trim(out.String(), " .")
}
