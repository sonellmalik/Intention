// ===== Shared Task Suggestion / Typeahead =====
//
// Powers the combobox used when scheduling a block (scheduler assign + edit
// modals) and when creating an event on the full Calendar. As you type in a
// title field it suggests your existing priorities and active to-dos so you can
// pull an item straight from your lists instead of retyping it.
//
// Matching is NOT a plain prefix search: it also matches on WORD OVERLAP, so a
// candidate whose wording differs but shares key words with what you typed still
// shows up (e.g. typing "essay" surfaces "Finish history essay draft"; typing
// "email prof" surfaces "Send professor an email").
//
// Loaded by both index.html (main app) and calendar.html (separate window). It
// reads the same focusflow_ localStorage keys in both, so suggestions stay in
// sync with the To-Do list and Priorities.

(function () {
    // Small stopword set so filler words don't create bogus matches.
    const STOPWORDS = new Set([
        'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'at',
        'my', 'me', 'i', 'is', 'be', 'do', 'with', 'this', 'that', 'it',
        'up', 'off', 'out', 'as', 'by', 'from', 'into', 'about'
    ]);

    function loadRaw(key, fallback) {
        try {
            const d = localStorage.getItem('focusflow_' + key);
            return d ? JSON.parse(d) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    // Break a string into lowercased word tokens (letters/numbers), no stopwords.
    function tokenize(str) {
        return String(str || '')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(t => t.length > 0 && !STOPWORDS.has(t));
    }

    // Are two tokens "the same idea"? Exact, prefix (>=3 chars), or one contains
    // the other (>=4 chars) — catches plurals/variants like plan/planning,
    // essay/essays, without matching unrelated short words.
    function tokensRelated(a, b) {
        if (a === b) return true;
        const min = Math.min(a.length, b.length);
        if (min >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
        if (min >= 4 && (a.includes(b) || b.includes(a))) return true;
        return false;
    }

    // Score a candidate against the query. Higher = better; 0 = no match.
    function score(query, candidateText) {
        const q = query.trim().toLowerCase();
        if (!q) return 0;

        const cLower = candidateText.toLowerCase();

        // Strong signals first.
        if (cLower === q) return 1000;
        if (cLower.startsWith(q)) return 800;
        if (cLower.includes(q)) return 600;

        const qTokens = tokenize(query);
        const cTokens = tokenize(candidateText);
        if (qTokens.length === 0 || cTokens.length === 0) return 0;

        // Count query tokens that relate to some candidate token (word overlap).
        let matched = 0;
        qTokens.forEach(qt => {
            if (cTokens.some(ct => tokensRelated(qt, ct))) matched++;
        });
        if (matched === 0) return 0;

        // Base on how much of the query is covered, plus a bonus for covering
        // more of the candidate (so tight matches rank above loose ones).
        const coverageQ = matched / qTokens.length;   // 0..1
        const coverageC = matched / cTokens.length;   // 0..1
        return Math.round(300 * coverageQ + 100 * coverageC + 20 * matched);
    }

    // Build the candidate pool: priorities + ACTIVE (not completed) to-dos.
    // De-duplicated by text (case-insensitive); priorities win on ties.
    function getCandidates() {
        const out = [];
        const seen = new Set();

        const priorities = loadRaw('priorities', []) || [];
        (Array.isArray(priorities) ? priorities : []).forEach(p => {
            const text = (p && p.text || '').trim();
            if (!text) return;
            const k = text.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            out.push({ text, kind: 'priority', type: 'todo' });
        });

        const todos = loadRaw('todos', []) || [];
        (Array.isArray(todos) ? todos : []).forEach(t => {
            if (!t || t.completed) return;
            const text = (t.text || '').trim();
            if (!text) return;
            const k = text.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            out.push({ text, kind: (t.type === 'break' ? 'break' : 'todo'), type: (t.type === 'break' ? 'break' : 'todo') });
        });

        return out;
    }

    // Return up to `limit` suggestions for `query`, best first.
    function suggest(query, limit) {
        const lim = limit || 6;
        const q = (query || '').trim();
        if (!q) return [];
        return getCandidates()
            .map(c => ({ ...c, _score: score(q, c.text) }))
            .filter(c => c._score > 0)
            .sort((a, b) => b._score - a._score || a.text.length - b._score)
            .slice(0, lim);
    }

    // Wire a text input to a live suggestions dropdown.
    //
    // opts:
    //   input        (required) the <input type=text>
    //   onPick(item) (required) called with {text, kind, type} when a suggestion
    //                is chosen; use it to fill the title + infer the type.
    //
    // Returns a small controller: { destroy() }.
    function attach(opts) {
        const input = opts.input;
        const onPick = opts.onPick || function () {};
        if (!input) return { destroy() {} };

        // Dropdown element, positioned right under the input in normal flow.
        const menu = document.createElement('div');
        menu.className = 'task-suggest-menu';
        menu.style.display = 'none';

        // Insert after the input (wrap so absolute positioning is contained).
        const host = document.createElement('div');
        host.className = 'task-suggest-host';
        input.parentNode.insertBefore(host, input);
        host.appendChild(input);
        host.appendChild(menu);

        let items = [];
        let activeIdx = -1;

        function close() {
            menu.style.display = 'none';
            menu.innerHTML = '';
            activeIdx = -1;
            items = [];
        }

        function render() {
            const q = input.value;
            items = suggest(q, 6);
            if (items.length === 0) { close(); return; }

            menu.innerHTML = items.map((it, i) => `
                <button type="button" class="task-suggest-item${i === activeIdx ? ' active' : ''}" data-idx="${i}">
                    <span class="task-suggest-text">${escapeHtml(it.text)}</span>
                    <span class="task-suggest-kind kind-${it.kind}">${it.kind === 'priority' ? 'Priority' : (it.kind === 'break' ? 'Break' : 'Task')}</span>
                </button>
            `).join('');
            menu.style.display = 'block';

            menu.querySelectorAll('.task-suggest-item').forEach(btn => {
                // Use mousedown so it fires before the input's blur closes the menu.
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    pick(parseInt(btn.dataset.idx, 10));
                });
            });
        }

        function pick(idx) {
            const it = items[idx];
            if (!it) return;
            input.value = it.text;
            close();
            onPick(it);
        }

        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str == null ? '' : String(str);
            return div.innerHTML;
        }

        function onInput() { activeIdx = -1; render(); }

        function onKeydown(e) {
            if (menu.style.display === 'none') return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                activeIdx = Math.min(items.length - 1, activeIdx + 1);
                render();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                activeIdx = Math.max(0, activeIdx - 1);
                render();
            } else if (e.key === 'Enter') {
                if (activeIdx >= 0) {
                    e.preventDefault();
                    // Prevent other same-element handlers (e.g. a form's Enter =
                    // submit) from also firing on this keystroke.
                    e.stopImmediatePropagation();
                    pick(activeIdx);
                }
                // If nothing highlighted, let Enter fall through (save the form).
            } else if (e.key === 'Escape') {
                if (menu.style.display !== 'none') {
                    e.preventDefault();
                    e.stopPropagation();
                    close();
                }
            }
        }

        input.addEventListener('input', onInput);
        input.addEventListener('keydown', onKeydown);
        input.addEventListener('blur', () => setTimeout(close, 120));
        input.setAttribute('autocomplete', 'off');

        return {
            destroy() {
                input.removeEventListener('input', onInput);
                input.removeEventListener('keydown', onKeydown);
                close();
            }
        };
    }

    window.taskSuggest = { suggest, attach, getCandidates, score };
})();
