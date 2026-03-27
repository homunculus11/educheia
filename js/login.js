// login.js
import { auth } from './firebase-config.js';
import {
    GoogleAuthProvider,
    getRedirectResult,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signInWithPopup,
    signInWithRedirect
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

const USERNAME_EMAIL_MAP_KEY = 'usernameEmailMap';
const googleProvider = new GoogleAuthProvider();
const DEFAULT_REDIRECT_PATH = '/episodes';
const AUTH_RETURN_KEY = 'authReturnTo';

const isAuthPath = (path) => /\/(?:(?:src\/)?(?:login|register)(?:\.html)?)$/i.test(String(path || '').replace(/\/+$/, ''));

const isSafeRedirect = (target) => {
    if (!target) return false;

    try {
        const parsed = new URL(target, window.location.origin);
        return parsed.origin === window.location.origin && !isAuthPath(parsed.pathname);
    } catch {
        return false;
    }
};

const readReturnTarget = () => {
    try {
        const value = sessionStorage.getItem(AUTH_RETURN_KEY);
        return isSafeRedirect(value) ? value : null;
    } catch {
        return null;
    }
};

const writeReturnTarget = (value) => {
    if (!isSafeRedirect(value)) return;

    try {
        sessionStorage.setItem(AUTH_RETURN_KEY, value);
    } catch {
        return;
    }
};

const clearReturnTarget = () => {
    try {
        sessionStorage.removeItem(AUTH_RETURN_KEY);
    } catch {
        return;
    }
};

const toRelativePath = (target) => {
    if (!isSafeRedirect(target)) return null;

    try {
        const parsed = new URL(target, window.location.origin);
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return null;
    }
};

const getRedirectTarget = () => {
    const storedTarget = readReturnTarget();
    if (storedTarget) {
        return toRelativePath(storedTarget) || DEFAULT_REDIRECT_PATH;
    }

    if (isSafeRedirect(document.referrer)) {
        return toRelativePath(document.referrer) || DEFAULT_REDIRECT_PATH;
    }

    return DEFAULT_REDIRECT_PATH;
};

const redirectAfterAuth = () => {
    const target = getRedirectTarget();
    clearReturnTarget();
    window.location.href = target;
};

const readUsernameEmailMap = () => {
    try {
        const raw = localStorage.getItem(USERNAME_EMAIL_MAP_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

const resolveLoginEmail = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return '';
    if (normalized.includes('@')) return normalized;

    const map = readUsernameEmailMap();
    return map[normalized] || '';
};

const persistUsernameAlias = (username, email) => {
    if (!username || !email) return;

    try {
        const raw = localStorage.getItem(USERNAME_EMAIL_MAP_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        parsed[String(username).trim().toLowerCase()] = String(email).trim().toLowerCase();
        localStorage.setItem(USERNAME_EMAIL_MAP_KEY, JSON.stringify(parsed));
    } catch {
        return;
    }
};

const getFriendlyAuthError = (err) => {
    const code = err?.code || '';

    if (code === 'auth/unauthorized-domain') {
        return 'Domeniu neautorizat pentru Google Sign-In. Adaugă domeniul curent în Firebase Console → Authentication → Settings → Authorized domains.';
    }

    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
        return 'Email sau parolă incorectă.';
    }

    if (code === 'auth/too-many-requests') {
        return 'Prea multe încercări. Încearcă din nou mai târziu.';
    }

    if (code === 'auth/popup-closed-by-user') {
        return 'Ai închis fereastra Google înainte să finalizezi autentificarea.';
    }

    if (code === 'auth/network-request-failed') {
        return 'Conexiune indisponibilă. Verifică internetul și încearcă din nou.';
    }

    return err?.message || 'A apărut o eroare de autentificare.';
};

const shouldFallbackToRedirect = (err) => {
    const code = err?.code || '';
    return code === 'auth/popup-blocked' || code === 'auth/web-storage-unsupported';
};

const setPendingState = (button, isPending, pendingLabel) => {
    if (!button) return;

    if (!button.dataset.defaultLabel) {
        button.dataset.defaultLabel = button.textContent.trim();
    }

    button.disabled = isPending;
    button.textContent = isPending ? pendingLabel : button.dataset.defaultLabel;
};

try {
    const redirectResult = await getRedirectResult(auth);
    if (redirectResult?.user) {
        persistUsernameAlias(redirectResult.user.displayName, redirectResult.user.email);
        redirectAfterAuth();
    }
} catch (err) {
    console.error('Google redirect login error', err);
    alert(getFriendlyAuthError(err));
}

// redirect if already logged in
onAuthStateChanged(auth, (user) => {
    if (user) {
        redirectAfterAuth();
    }
});

const loginForm = document.querySelector('.login-form');

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitButton = loginForm.querySelector('button[type="submit"]');
        const user = loginForm.user.value.trim();
        const password = loginForm.password.value;
        const email = resolveLoginEmail(user);

        if (!email) {
            alert('Folosește adresa de email sau un username deja înregistrat pe acest browser.');
            return;
        }

        try {
            setPendingState(submitButton, true, 'Signing In...');
            await signInWithEmailAndPassword(auth, email, password);
            redirectAfterAuth();
        } catch (err) {
            console.error('Login error', err);
            alert(getFriendlyAuthError(err));
        } finally {
            setPendingState(submitButton, false, 'Signing In...');
        }
    });
}

const googleLoginButton = document.querySelector('.btn-google');

if (googleLoginButton) {
    googleLoginButton.addEventListener('click', async () => {
        if (window.location.protocol === 'file:') {
            alert('Google Sign-In nu funcționează din file://. Rulează aplicația pe localhost.');
            return;
        }

        try {
            setPendingState(googleLoginButton, true, 'Connecting...');
            const result = await signInWithPopup(auth, googleProvider);
            persistUsernameAlias(result.user.displayName, result.user.email);
            redirectAfterAuth();
        } catch (err) {
            if (shouldFallbackToRedirect(err)) {
                try {
                    writeReturnTarget(getRedirectTarget());
                    await signInWithRedirect(auth, googleProvider);
                    return;
                } catch (redirectErr) {
                    console.error('Google redirect start error', redirectErr);
                    alert(getFriendlyAuthError(redirectErr));
                }
            } else {
                console.error('Google login error', err);
                alert(getFriendlyAuthError(err));
            }
        } finally {
            setPendingState(googleLoginButton, false, 'Connecting...');
        }
    });
}
