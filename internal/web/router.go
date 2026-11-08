package web

import (
	"io/fs"
	"net/http"

	"notediscovery/internal/config"
	"notediscovery/internal/session"
	"notediscovery/internal/vault"
)

type Server struct {
	cfg     *config.Config
	vault   *vault.Vault
	session *session.Manager
	mux     *http.ServeMux
	handler http.Handler
}

func NewServer(cfg *config.Config, v *vault.Vault, sess *session.Manager, assetsFS fs.FS, ntfyUpdater ...func(config.NtfyConfig) error) *Server {
	mux := http.NewServeMux()

	authH := NewAuthHandler(cfg, sess, assetsFS)
	notesH := NewNotesHandler(cfg, v)
	todosH := NewTodosHandler(cfg, v)
	foldersH := NewFoldersHandler(cfg, v)
	mediaH := NewMediaHandler(cfg, v)
	tagsH := NewTagsSearchHandler(cfg, v)
	queriesH := NewQueriesHandler(v)
	sysH := NewSystemHandler(cfg, v, assetsFS, ntfyUpdater...)
	staticH := NewStaticHandler(cfg, assetsFS)

	// Auth & Page routes
	mux.HandleFunc("GET /login", authH.LoginPageRoute)
	mux.HandleFunc("POST /login", authH.LoginAction)
	mux.HandleFunc("POST /logout", authH.LogoutAction)
	mux.HandleFunc("GET /logout", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", "POST")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
	})

	// Static & Manifest
	mux.HandleFunc("GET /manifest.json", staticH.ServeManifest)
	mux.HandleFunc("GET /sw.js", staticH.ServeSW)
	mux.HandleFunc("GET /static/", staticH.ServeStatic)

	// System & Health
	mux.HandleFunc("GET /health", sysH.GetHealth)
	mux.HandleFunc("GET /api/health", sysH.GetHealth)
	mux.HandleFunc("GET /api/config", sysH.GetConfig)
	mux.HandleFunc("POST /api/ntfy/config", sysH.UpdateNtfyConfig)
	mux.HandleFunc("GET /api/stats", sysH.GetStats)
	mux.HandleFunc("GET /api/index/stats", sysH.GetStats)
	mux.HandleFunc("GET /api/graph", sysH.GetGraph)

	// Themes & Locales
	mux.HandleFunc("GET /api/themes", sysH.ListThemes)
	mux.HandleFunc("GET /api/themes/{id}", sysH.GetThemeCSS)
	mux.HandleFunc("GET /api/locales", sysH.ListLocales)
	mux.HandleFunc("GET /api/locales/{code}", sysH.GetLocale)

	// Export & Archive
	mux.HandleFunc("GET /api/export/{path...}", sysH.ExportNote)
	mux.HandleFunc("GET /api/archive", sysH.ArchiveFolder)

	// Tags & Search
	mux.HandleFunc("GET /api/tags", tagsH.GetAllTags)
	mux.HandleFunc("GET /api/tags/{tag}", tagsH.GetNotesByTag)
	mux.HandleFunc("GET /api/search", tagsH.SearchNotes)
	mux.HandleFunc("POST /api/query", queriesH.Run)
	mux.HandleFunc("GET /api/todos", todosH.ListTodos)
	mux.HandleFunc("POST /api/todos/config", todosH.UpdateKeywords)

	// Notes: literal paths before wildcards
	mux.HandleFunc("POST /api/notes/replace", notesH.ReplaceInNote)
	mux.HandleFunc("POST /api/notes/move", notesH.MoveNote)
	mux.HandleFunc("GET /api/notes", notesH.ListNotes)
	mux.HandleFunc("GET /api/notes/{path...}", notesH.GetNote)
	mux.HandleFunc("POST /api/notes/{path...}", notesH.SaveNote)
	mux.HandleFunc("PATCH /api/notes/{path...}", notesH.SaveNote)
	mux.HandleFunc("DELETE /api/notes/{path...}", notesH.DeleteNote)

	// Folders: literal paths before wildcards
	mux.HandleFunc("POST /api/folders/move", foldersH.MoveFolder)
	mux.HandleFunc("POST /api/folders/rename", foldersH.RenameFolder)
	mux.HandleFunc("POST /api/folders", foldersH.CreateFolder)
	mux.HandleFunc("DELETE /api/folders/{path...}", foldersH.DeleteFolder)

	// Media
	mux.HandleFunc("POST /api/upload-media", mediaH.UploadMedia)
	mux.HandleFunc("POST /api/media/move", mediaH.MoveMedia)
	mux.HandleFunc("GET /api/media/{path...}", mediaH.GetMedia)

	// Catch-all SPA
	mux.HandleFunc("GET /{$}", staticH.ServeIndex)
	mux.HandleFunc("GET /{path...}", staticH.CatchAll)

	// Wrap in Auth Middleware
	authed := authH.RequireAuth(mux)

	// Wrap in CORS
	corsHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		addVary(w, "Origin")

		origin := r.Header.Get("Origin")
		allowed := false
		allowedOrigin := ""
		wildcard := false
		for _, o := range cfg.Server.AllowedOrigins {
			if o == "*" {
				wildcard = true
				break
			}
		}
		if wildcard {
			allowed = true
			allowedOrigin = "*"
		} else {
			for _, o := range cfg.Server.AllowedOrigins {
				if o != "" && o == origin {
					allowed = true
					allowedOrigin = o
					break
				}
			}
		}

		if allowed {
			// Wildcard never allows credentials; specific origins are only
			// honored when they exactly match the request Origin.
			if allowedOrigin == "*" {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			} else if origin != "" && origin == allowedOrigin {
				w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}
		}

		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		authed.ServeHTTP(w, r)
	})

	return &Server{
		cfg:     cfg,
		vault:   v,
		session: sess,
		mux:     mux,
		// Outermost layer: gzip everything the client accepts (shell, static
		// assets and JSON API), decided per response by Content-Type.
		// Inside: security headers + CORS/auth chain.
		handler: gzipHandler(securityHeadersHandler(corsHandler)),
	}
}

// securityHeadersHandler adds baseline security headers to every response.
func securityHeadersHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}
