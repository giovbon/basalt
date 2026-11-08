// Full-text search, in-editor/in-preview highlighting, match nav.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { CONFIG, LOCAL_SETTINGS } from '../core/config.js';
import { foldForSearch, foldedIndexForOriginal, isWholeWordMatch, lineStartOffset } from '../lib/search-fold.js';
import {
    previewMarkIndexForSourceOffset,
    searchHiddenRegions,
    sourceOffsetForLineColumn,
    spanOverlapsRegions,
} from '../lib/search-preview.js';

export function createSearch() {
    return {
        
        // Fold text for accent-insensitive, case-insensitive matching. Returns
        // the folded string plus a map from each folded code unit to the
        // original index, so highlights can slice the original text even when
        // NFD normalization changes its length.
        // Search folding and offset mapping live in lib/search-fold.js; these
        // wrappers keep the (widely used) component method names stable.
        _foldForSearch(text) {
            return foldForSearch(text);
        },

        // First folded index whose original position is >= origIndex.
        _foldedIndexForOriginal(map, origIndex) {
            return foldedIndexForOriginal(map, origIndex);
        },

        // 0-based character offset where a 1-based source line starts.
        _lineStartOffset(content, line) {
            return lineStartOffset(content, line);
        },

        // Highlight search term in editor and preview
        highlightSearchTerm(query, focusEditor = false, targetLine = null, targetColumn = null) {
            if (!query || !query.trim()) {
                this._searchTargetAfterRender = null;
                this.clearSearchHighlights();
                return;
            }
            
            const searchTerm = query.trim();
            if (this._searchTargetAfterRender
                && this._searchTargetAfterRender.query !== searchTerm) {
                this._searchTargetAfterRender = null;
            }
            
            // Highlight in editor (textarea)
            this.highlightInEditor(searchTerm, focusEditor, targetLine, targetColumn);
            
            // Highlight in preview (rendered HTML)
            this.highlightInPreview(searchTerm, targetLine, targetColumn);
        },

        // Re-apply the current search highlight after the preview re-rendered
        // (note loaded, or the user edited the note). Keeps whichever
        // occurrence was active and leaves the scroll position alone: the pass
        // that runs right after a search click has already scrolled to the
        // chosen occurrence, and snapping back to match 0 here is what made the
        // clicked occurrence lose its highlight.
        _reapplySearchHighlights() {
            const query = this.currentSearchHighlight;
            if (!query) return;
            const keepIndex = this.currentMatchIndex;
            this.highlightInEditor(query, false, null, null, { scroll: false });
            this.highlightInPreview(query, null, null, {
                keepActiveIndex: keepIndex,
                scroll: false,
            });
        },

        // Highlight search term in the editor textarea
        highlightInEditor(searchTerm, shouldFocus = false, targetLine = null, targetColumn = null, opts = {}) {
            const editor = this._domCache.editor || document.getElementById('editor');
            if (!editor) return;
            
            // A textarea cannot contain styled marks, so the editor side is
            // about scrolling to (and optionally selecting) the right match.
            const content = editor.value;
            const foldedContent = this._foldForSearch(content);
            const foldedTerm = this._foldForSearch(searchTerm).text;
            if (!foldedTerm) return;

            let index = -1;
            let foundOnTargetLine = false;
            if (targetLine && targetLine > 0) {
                const lineStart = this._lineStartOffset(content, targetLine);
                const lineEnd = this._lineStartOffset(content, targetLine + 1);
                const foldedStart = this._foldedIndexForOriginal(foldedContent.map, lineStart);

                // A line can hold several occurrences of the same term, so the
                // column the sidebar reported pins the exact one. Using only
                // the line used to select the first match on it.
                if (targetColumn && targetColumn > 0) {
                    const offset = this._sourceOffsetForLineColumn(content, targetLine, targetColumn);
                    const foldedIdx = this._foldedIndexForOriginal(foldedContent.map, offset);
                    if (foldedContent.text.startsWith(foldedTerm, foldedIdx)
                        && (!this.exactSearchMatch || isWholeWordMatch(content, foldedContent.map[foldedIdx], foldedContent.map[foldedIdx + foldedTerm.length]))
                        && foldedContent.map[foldedIdx] < lineEnd) {
                        index = foldedIdx;
                        foundOnTargetLine = true;
                    }
                }

                if (index === -1) {
                    let candidate = foldedContent.text.indexOf(foldedTerm, foldedStart);
                    while (candidate !== -1 && foldedContent.map[candidate] < lineEnd
                        && this.exactSearchMatch
                        && !isWholeWordMatch(content, foldedContent.map[candidate], foldedContent.map[candidate + foldedTerm.length])) {
                        candidate = foldedContent.text.indexOf(foldedTerm, candidate + foldedTerm.length);
                    }
                    // Only accept the candidate when it actually starts on the
                    // requested line; otherwise the note changed since the search.
                    if (candidate !== -1 && foldedContent.map[candidate] < lineEnd
                        && (!this.exactSearchMatch || isWholeWordMatch(content, foldedContent.map[candidate], foldedContent.map[candidate + foldedTerm.length]))) {
                        index = candidate;
                        foundOnTargetLine = true;
                    }
                }
            }
            // Fall back to the first occurrence when the requested line has no
            // match (e.g. the line number came from a different revision).
            if (index === -1) {
                let candidate = foldedContent.text.indexOf(foldedTerm);
                while (candidate !== -1 && this.exactSearchMatch
                    && !isWholeWordMatch(content, foldedContent.map[candidate], foldedContent.map[candidate + foldedTerm.length])) {
                    candidate = foldedContent.text.indexOf(foldedTerm, candidate + foldedTerm.length);
                }
                index = candidate;
            }

            let targetScroll = null;
            if (opts.scroll !== false) {
                const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
                if (foundOnTargetLine) {
                    targetScroll = Math.max(0, (targetLine - 5) * lineHeight);
                } else if (index !== -1) {
                    const lineNumber = content.substring(0, foldedContent.map[index]).split('\n').length;
                    targetScroll = Math.max(0, (lineNumber - 5) * lineHeight);
                }
                if (targetScroll !== null) {
                    this._suspendScrollSync();
                    editor.scrollTop = targetScroll;
                }
            }

            if (index !== -1 && shouldFocus) {
                const start = foldedContent.map[index];
                const end = foldedContent.map[index + foldedTerm.length];

                // Place the caret before focusing: focus() reveals the current
                // caret, and the caret left at the end of the previous note
                // scrolled the editor to the bottom (scroll-sync then dragged
                // the preview down with it).
                editor.setSelectionRange(start, end);
                editor.focus();
                if (targetScroll !== null) {
                    this._suspendScrollSync();
                    editor.scrollTop = targetScroll;
                }
                
                // Blur immediately so the selection stays visible but editor isn't focused
                setTimeout(() => editor.blur(), 100);
            }
        },
        
        // Highlight search term in the preview pane
        highlightInPreview(searchTerm, targetLine = null, targetColumn = null, opts = {}) {
            const preview = document.querySelector('.markdown-preview');
            if (!preview) return;
            
            // Remove existing highlights
            this.clearSearchHighlights();

            const foldedTerm = this._foldForSearch(searchTerm).text;
            if (!foldedTerm) return;
            
            // Create a tree walker to find all text nodes
            const walker = document.createTreeWalker(
                preview,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            
            const textNodes = [];
            let node;
            while (node = walker.nextNode()) {
                // Skip anything inside <code>/<pre>. closest() (rather than a
                // parent check) also covers the copy buttons the renderer
                // injects into every <pre>, whose text is not note content.
                if (node.parentElement && node.parentElement.closest('code, pre')) {
                    continue;
                }
                textNodes.push(node);
            }
            
            let matchIndex = 0;
            
            // Highlight matches in text nodes
            textNodes.forEach(textNode => {
                const text = textNode.textContent;
                const foldedText = this._foldForSearch(text);
                
                const fragment = document.createDocumentFragment();
                let lastOriginal = 0;
                let searchFrom = 0;
                let matchesInNode = 0;
                let index;
                
                while ((index = foldedText.text.indexOf(foldedTerm, searchFrom)) !== -1) {
                    const start = foldedText.map[index];
                    const end = foldedText.map[index + foldedTerm.length];
                    if (this.exactSearchMatch && !isWholeWordMatch(text, start, end)) {
                        searchFrom = index + foldedTerm.length;
                        continue;
                    }
                    
                    // Add text before match
                    if (start > lastOriginal) {
                        fragment.appendChild(
                            document.createTextNode(text.substring(lastOriginal, start))
                        );
                    }
                    
                    // Add highlighted match
                    const mark = document.createElement('mark');
                    mark.className = 'search-highlight';
                    mark.setAttribute('data-match-index', matchIndex);
                    mark.textContent = text.substring(start, end);
                    
                    // First match is active (styled via CSS)
                    if (matchIndex === 0) {
                        mark.classList.add('active-match');
                    }
                    
                    fragment.appendChild(mark);
                    matchIndex++;
                    matchesInNode++;
                    lastOriginal = end;
                    searchFrom = index + foldedTerm.length;
                }
                
                if (matchesInNode > 0) {
                    // Add remaining text
                    if (lastOriginal < text.length) {
                        fragment.appendChild(
                            document.createTextNode(text.substring(lastOriginal))
                        );
                    }
                    
                    // Replace text node with highlighted fragment
                    textNode.parentNode.replaceChild(fragment, textNode);
                }
            });
            
            // Update total matches and reset current index
            this.totalMatches = matchIndex;
            this.currentMatchIndex = matchIndex > 0 ? 0 : -1;

            const marks = preview.querySelectorAll('mark.search-highlight');

            // Re-apply pass (the note re-rendered while highlights were
            // already showing): keep the occurrence that was active, and leave
            // the viewport where it is unless asked to scroll.
            if (opts.keepActiveIndex != null) {
                if (marks.length === 0) {
                    this.currentMatchIndex = -1;
                    return;
                }
                const keep = opts.keepActiveIndex < 0
                    ? -1
                    : Math.min(opts.keepActiveIndex, marks.length - 1);
                marks.forEach((mark, i) => {
                    mark.classList.toggle('active-match', i === keep);
                });
                this.currentMatchIndex = keep;
                if (opts.scroll !== false && keep >= 0) this.scrollToMatch(keep);
                return;
            }
            
            // Prefer the exact occurrence the user clicked; otherwise scroll
            // to the first highlighted match.
            if (targetLine && targetLine > 0) {
                this._focusPreviewOccurrence(marks, targetLine, targetColumn, foldedTerm);
            } else if (this.totalMatches > 0 && opts.scroll !== false) {
                this.scrollToMatch(0);
            }
        },

        // Make the occurrence at line:column the active <mark> and scroll it
        // into view. When the source-side numbering cannot be trusted (the
        // term also appears in code, link targets, math, …) fall back to the
        // mark nearest the block anchor for that line.
        _focusPreviewOccurrence(marks, targetLine, targetColumn, foldedTerm) {
            if (marks.length === 0) {
                this.scrollPreviewToSourceLine(targetLine);
                this.currentMatchIndex = -1;
                return;
            }

            const offset = this._sourceOffsetForLineColumn(
                this.noteContent || '', targetLine, targetColumn
            );
            let index = this._previewMarkIndexForSourceOffset(offset, foldedTerm, marks.length);

            if (index === -1) {
                // The occurrence lives in frontmatter or in code: the preview
                // has no mark for it (the editor still selects it).
                marks.forEach((mark) => mark.classList.remove('active-match'));
                this.scrollPreviewToSourceLine(targetLine);
                this.currentMatchIndex = -1;
                return;
            }

            if (index < 0) {
                // Counts disagree: keep the old "nearest to the anchor" pick.
                this.scrollPreviewToSourceLine(targetLine);
                const container = this._domCache.previewContainer;
                if (!container) return;
                const anchor = container.scrollTop + 100;
                let best = 0;
                let bestDist = Infinity;
                marks.forEach((mark, i) => {
                    const dist = Math.abs(this._scrollTopOfPreviewElement(mark) - anchor);
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = i;
                    }
                });
                index = best;
            }

            marks.forEach((mark, i) => {
                mark.classList.toggle('active-match', i === index);
            });
            this.currentMatchIndex = index;
            this._scrollPreviewToElement(marks[index], 100, { suppressSync: true });
        },

        // Index of the <mark> that corresponds to a source offset (see lib/search-preview.js).
        _previewMarkIndexForSourceOffset(offset, foldedTerm, markCount) {
            return previewMarkIndexForSourceOffset(
                this.noteContent || '',
                offset,
                foldedTerm,
                markCount,
                this.exactSearchMatch
            );
        },

        // 0-based character offset of a 1-based line:column (see lib/search-preview.js).
        _sourceOffsetForLineColumn(content, line, column = 1) {
            return sourceOffsetForLineColumn(content, line, column);
        },

        // Hidden preview regions and span checks live in lib/search-preview.js.
        _searchHiddenRegions(content) {
            return searchHiddenRegions(content);
        },

        _spanOverlapsRegions(regions, start, end) {
            return spanOverlapsRegions(regions, start, end);
        },

        // Scroll `el` (a preview descendant) to `offset` px below the top of
        // the preview pane. Rect-based so it does not depend on which ancestor
        // happens to be the offset parent. suppressSync is used by jumps that
        // also position the editor themselves: mirroring this write back would
        // replace the exact target with a proportional guess.
        _scrollPreviewToElement(el, offset = 100, opts = {}) {
            const container = this._domCache.previewContainer;
            if (!container || !el) return;
            const cRect = container.getBoundingClientRect();
            const eRect = el.getBoundingClientRect();
            if (opts.suppressSync) this._suspendScrollSync();
            container.scrollTop = Math.max(0, container.scrollTop + eRect.top - cRect.top - offset);
        },

        // Current scroll offset of a preview element inside the preview pane.
        _scrollTopOfPreviewElement(el) {
            const container = this._domCache.previewContainer;
            if (!container || !el) return 0;
            const cRect = container.getBoundingClientRect();
            const eRect = el.getBoundingClientRect();
            return container.scrollTop + eRect.top - cRect.top;
        },

        // Scroll the textarea to a 1-based source line.
        scrollEditorToLine(line) {
            const editor = this._domCache.editor || document.getElementById('editor');
            if (!editor || !line || line < 1) return;
            const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
            editor.scrollTop = Math.max(0, (line - 5) * lineHeight);
        },

        // Scroll the preview to the nearest block carrying a data-source-line
        // anchor (the markdown renderer stamps these during scroll-sync setup).
        // Anchors store 0-based line indexes because they drive scroll-sync
        // against the editor, while search results report 1-based lines.
        scrollPreviewToSourceLine(line) {
            const preview = document.querySelector('.markdown-preview');
            if (!preview || !line) return;

            const target = line - 1;
            const anchors = preview.querySelectorAll('[data-source-line]');
            let best = null;
            let bestLine = -1;
            for (const el of anchors) {
                const anchorLine = parseInt(el.getAttribute('data-source-line'), 10);
                if (!Number.isFinite(anchorLine)) continue;
                if (anchorLine === target) {
                    best = el;
                    bestLine = anchorLine;
                    break;
                }
                if (anchorLine <= target && anchorLine > bestLine) {
                    best = el;
                    bestLine = anchorLine;
                }
            }

            if (!best) {
                const firstMatch = preview.querySelector('mark.search-highlight');
                if (firstMatch) this._scrollPreviewToElement(firstMatch, 100, { suppressSync: true });
                return;
            }
            this._scrollPreviewToElement(best, 100, { suppressSync: true });
        },
        
        // Navigate to next search match
        nextMatch() {
            if (this.totalMatches === 0) return;
            
            this.currentMatchIndex = (this.currentMatchIndex + 1) % this.totalMatches;
            this.scrollToMatch(this.currentMatchIndex);
        },
        
        // Navigate to previous search match
        previousMatch() {
            if (this.totalMatches === 0) return;
            
            this.currentMatchIndex = (this.currentMatchIndex - 1 + this.totalMatches) % this.totalMatches;
            this.scrollToMatch(this.currentMatchIndex);
        },
        
        // Scroll to a specific match index
        scrollToMatch(index) {
            const preview = document.querySelector('.markdown-preview');
            if (!preview) return;
            
            const allMatches = preview.querySelectorAll('mark.search-highlight');
            if (index < 0 || index >= allMatches.length) return;
            
            // Update styling - make current match prominent (via CSS class)
            allMatches.forEach((mark, i) => {
                mark.classList.toggle('active-match', i === index);
            });
            
            // Scroll to the match
            const targetMatch = allMatches[index];
            if (targetMatch) this._scrollPreviewToElement(targetMatch);
        },

        activateSearchMatch(target) {
            const mark = target && typeof target.closest === 'function'
                ? target.closest('.markdown-preview mark.search-highlight')
                : null;
            if (!mark) return;

            const marks = [...document.querySelectorAll('.markdown-preview mark.search-highlight')];
            const index = marks.indexOf(mark);
            if (index === -1) return;

            marks.forEach((match, matchIndex) => {
                match.classList.toggle('active-match', matchIndex === index);
            });
            this.currentMatchIndex = index;
        },
        
        // Clear search highlights
        clearSearchHighlights() {
            const preview = document.querySelector('.markdown-preview');
            if (!preview) return;
            
            const highlights = preview.querySelectorAll('mark.search-highlight');
            highlights.forEach(mark => {
                const text = document.createTextNode(mark.textContent);
                mark.parentNode.replaceChild(text, mark);
            });
            
            // Normalize text nodes to merge adjacent text nodes
            preview.normalize();
            
            // Reset match counters
            this.totalMatches = 0;
            this.currentMatchIndex = -1;
        },
        
        // Search notes
        // Whether the query is worth sending. A single character matches most of
        // a vault and can't use the search index, so it reads every note to
        // answer something nobody wants — the sidebar shows its hint instead.
        isSearchable() {
            return this.searchQuery.trim().length >= CONFIG.SEARCH_MIN_QUERY_LENGTH;
        },

        debouncedSearchNotes() {
            if (this.searchDebounceTimeout) {
                clearTimeout(this.searchDebounceTimeout);
            }

            const hasTextSearch = this.isSearchable();
            if (!hasTextSearch) {
                this.isSearching = false;
                this.searchNotes();
                return;
            }

            this.isSearching = true;
            this.searchResults = [];

            this.searchDebounceTimeout = setTimeout(() => {
                this.searchNotes();
            }, CONFIG.SEARCH_DEBOUNCE_DELAY);
        },

        // Search notes by text (calls unified filter logic)
        async searchNotes() {
            await this.applyFilters();
        },

        // Collapsible search result groups. Keeping the state in a plain object
        // (path -> bool) lets the sidebar show only note headers until the user
        // asks for the individual occurrences.
        toggleSearchResult(path) {
            this.expandedSearchResults = {
                ...this.expandedSearchResults,
                [path]: !this.expandedSearchResults[path],
            };
        },

        isSearchResultExpanded(path) {
            return !!this.expandedSearchResults[path];
        },

        expandAllSearchResults() {
            const expanded = {};
            for (const result of this.searchResults) {
                expanded[result.path] = true;
            }
            this.expandedSearchResults = expanded;
        },

        collapseAllSearchResults() {
            this.expandedSearchResults = {};
        },

        // Open a note at the exact occurrence the user clicked.
        openSearchMatch(path, match, query) {
            const line = match && match.line_number ? match.line_number : null;
            // The column pins the occurrence when one line holds several of
            // them; without it the first match on the line would be picked.
            const column = match && match.column ? match.column : null;
            this.openItem(path, 'note', query, line, column);
        },

        toggleExactSearchMatch() {
            this.exactSearchMatch = !this.exactSearchMatch;
            this.debouncedSearchNotes();
        },
    };
}
