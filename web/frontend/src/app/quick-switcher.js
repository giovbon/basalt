// Quick switcher overlay (Ctrl+Alt+P).
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

export function createQuickSwitcher() {
    return {
        
        // ============================================
        // Quick Switcher (Ctrl+Alt+P)
        // ============================================
        
        openQuickSwitcher() {
            this.showQuickSwitcher = true;
            this.quickSwitcherQuery = '';
            this.quickSwitcherIndex = 0;
            // Populate initial results
            this.quickSwitcherResults = (this.allNotes || []).slice(0, 10);
            // Focus the input after the modal renders
            this.$nextTick(() => {
                const input = document.getElementById('quickSwitcherInput');
                if (input) input.focus();
            });
        },
        
        closeQuickSwitcher() {
            this.showQuickSwitcher = false;
            this.quickSwitcherQuery = '';
            this.quickSwitcherIndex = 0;
        },
        
        // Filter notes and PDFs for quick switcher based on query
        filterQuickSwitcher(query) {
            // Other media (such as images) are intentionally excluded.
            const notes = (this.notes || []).filter(n => n.type === 'note' || n.type === 'document');
            if (!query || !query.trim()) {
                // Show recent notes when no query
                return notes.slice(0, 10);
            }
            const q = query.toLowerCase();
            return notes
                .filter(n => 
                    n.name.toLowerCase().includes(q) || 
                    n.path.toLowerCase().includes(q)
                )
                .slice(0, 10);
        },
        
        // Handle keyboard navigation in quick switcher
        handleQuickSwitcherKeydown(e) {
            const results = this.quickSwitcherResults;
            
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.quickSwitcherIndex = Math.min(this.quickSwitcherIndex + 1, results.length - 1);
                this.scrollQuickSwitcherIntoView();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.quickSwitcherIndex = Math.max(this.quickSwitcherIndex - 1, 0);
                this.scrollQuickSwitcherIntoView();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const note = results[this.quickSwitcherIndex];
                if (note) {
                    this.openItem(note.path, note.type);
                    this.closeQuickSwitcher();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeQuickSwitcher();
            }
        },
        
        // Scroll selected item into view in quick switcher
        scrollQuickSwitcherIntoView() {
            this.$nextTick(() => {
                const items = document.querySelectorAll('[data-quick-switcher-item]');
                if (items[this.quickSwitcherIndex]) {
                    items[this.quickSwitcherIndex].scrollIntoView({ block: 'nearest' });
                }
            });
        },
        
        // Select note from quick switcher by click
        selectQuickSwitcherNote(note) {
            this.openItem(note.path, note.type);
            this.closeQuickSwitcher();
        },
    };
}
