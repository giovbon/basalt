// Locale loading, translation helpers, and user-facing toast messages.

import { CONFIG } from '../core/config.js';
import * as api from '../core/api.js';
import { saveSetting } from '../core/settings.js';
import { translate } from '../core/i18n.js';

export function createLocalization() {
    return {
        t(key, params = {}) {
            return translate(this.translations, key, params);
        },

        toast(message, options = {}) {
            if (typeof message !== 'string' || !message) return;
            const type = ['error', 'warning', 'info', 'success'].includes(options.type)
                ? options.type
                : 'info';
            let durationMs = options.durationMs;
            if (durationMs == null || typeof durationMs !== 'number' || durationMs < 0) {
                durationMs = type === 'error' ? CONFIG.TOAST_DURATION_ERROR_MS
                    : type === 'warning' ? CONFIG.TOAST_DURATION_WARNING_MS
                        : type === 'success' ? CONFIG.TOAST_DURATION_SUCCESS_MS
                            : CONFIG.TOAST_DURATION_INFO_MS;
            }
            const id = ++this._toastIdSeq;
            const entry = { id, message, type, _tid: null };
            this.toasts.push(entry);
            while (this.toasts.length > CONFIG.TOAST_MAX_VISIBLE) {
                const first = this.toasts.shift();
                if (first && first._tid) clearTimeout(first._tid);
            }
            entry._tid = setTimeout(() => this.dismissToast(id), durationMs);
            return id;
        },

        dismissToast(id) {
            const idx = this.toasts.findIndex((t) => t.id === id);
            if (idx === -1) return;
            const entry = this.toasts[idx];
            if (entry._tid) {
                clearTimeout(entry._tid);
                entry._tid = null;
            }
            this.toasts.splice(idx, 1);
        },

        getValidationErrorMessage(validation, type = 'note') {
            switch (validation.error) {
                case 'empty':
                    return type === 'note'
                        ? this.t('notes.empty_name')
                        : this.t('folders.invalid_name');
                case 'forbidden_chars':
                    return this.t('validation.forbidden_chars', {
                        chars: validation.forbiddenChars
                    });
                case 'reserved_name':
                    return this.t('validation.reserved_name');
                case 'invalid_dot':
                    return this.t('validation.invalid_dot');
                case 'trailing_dot_space':
                    return this.t('validation.trailing_dot_space');
                default:
                    return type === 'note'
                        ? this.t('notes.invalid_name')
                        : this.t('folders.invalid_name');
            }
        },

        async loadAvailableLocales() {
            try {
                const data = await api.getJSON('/api/locales');
                this.availableLocales = data.locales || [];
            } catch (error) {
                console.error('Failed to load available locales:', error);
                this.availableLocales = [{ code: 'pt-BR', name: 'Português (Brasil)', flag: '🇧🇷' }];
            }
        },

        async loadLocale(localeCode = null) {
            const targetLocale = localeCode || localStorage.getItem('locale') || 'pt-BR';

            try {
                const response = await api.raw(`/api/locales/${targetLocale}`);
                if (response.ok) {
                    this.translations = await response.json();
                    this.currentLocale = targetLocale;
                    saveSetting('locale', targetLocale);
                } else if (targetLocale !== 'pt-BR') {
                    await this.loadLocale('pt-BR');
                }
            } catch (error) {
                console.error('Failed to load locale:', error);
                if (targetLocale !== 'pt-BR') {
                    await this.loadLocale('pt-BR');
                }
            }
        },

        async changeLocale(localeCode) {
            await this.loadLocale(localeCode);
        },
    };
}
