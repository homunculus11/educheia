import { auth } from './firebase-config.js';
import {
    onAuthStateChanged,
    signOut,
    updateProfile,
    sendEmailVerification,
    sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

const feedback = document.getElementById('account-feedback');
const profileForm = document.getElementById('profile-form');
const nameInput = document.getElementById('account-name');
const emailInput = document.getElementById('account-email');
const emailStatus = document.getElementById('email-status');
const verifyBtn = document.getElementById('verify-email-btn');
const resetPasswordBtn = document.getElementById('reset-password-btn');
const logoutBtn = document.getElementById('logout-account-btn');
const saveProfileBtn = document.getElementById('save-profile');
const accountRoleStatus = document.getElementById('account-role-status');

const setFeedback = (message, type = '') => {
    if (!feedback) return;

    feedback.textContent = message;
    feedback.classList.remove('is-success', 'is-error');

    if (type === 'success') feedback.classList.add('is-success');
    if (type === 'error') feedback.classList.add('is-error');
};

const getReadableAuthError = (error) => {
    const code = error?.code || '';

    if (code.includes('requires-recent-login')) {
        return 'Pentru această acțiune trebuie să te reconectezi.';
    }

    if (code.includes('too-many-requests')) {
        return 'Prea multe cereri. Încearcă din nou în câteva minute.';
    }

    return 'A apărut o eroare. Încearcă din nou.';
};

const setButtonsDisabled = (disabled) => {
    saveProfileBtn && (saveProfileBtn.disabled = disabled);
    verifyBtn && (verifyBtn.disabled = disabled);
    resetPasswordBtn && (resetPasswordBtn.disabled = disabled);
    logoutBtn && (logoutBtn.disabled = disabled);
};

const renderUser = (user) => {
    if (nameInput) {
        nameInput.value = (user.displayName || user.email?.split('@')[0] || '').trim();
    }

    if (emailInput) {
        emailInput.value = user.email || '';
    }

    if (emailStatus) {
        emailStatus.textContent = user.emailVerified ? 'Email verificat ✅' : 'Email neverificat';
    }
};

const getUserClaims = async (user) => {
    if (!user) return {};

    try {
        const tokenResult = await user.getIdTokenResult(true);
        return tokenResult?.claims || {};
    } catch {
        return {};
    }
};

const renderRoleStatus = (claims = {}) => {
    if (!accountRoleStatus) return;

    const isAdmin = Boolean(claims?.admin);
    accountRoleStatus.classList.toggle('is-admin', isAdmin);
    accountRoleStatus.textContent = isAdmin
        ? 'Rol cont: Admin. Ai acces la funcționalitățile administrative.'
        : 'Rol cont: Membru.';
};

const initAccountPage = () => {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = '/login';
            return;
        }

        const claims = await getUserClaims(user);
        renderUser(user);
        renderRoleStatus(claims);
        setFeedback('Datele contului au fost încărcate.', 'success');
    });

    profileForm?.addEventListener('submit', async (event) => {
        event.preventDefault();

        const user = auth.currentUser;
        if (!user) {
            window.location.href = '/login';
            return;
        }

        const nextDisplayName = nameInput?.value?.trim();
        if (!nextDisplayName) {
            setFeedback('Numele afișat este obligatoriu.', 'error');
            return;
        }

        try {
            setButtonsDisabled(true);
            await updateProfile(user, { displayName: nextDisplayName });
            setFeedback('Profil actualizat cu succes.', 'success');
        } catch (error) {
            setFeedback(getReadableAuthError(error), 'error');
        } finally {
            setButtonsDisabled(false);
        }
    });

    verifyBtn?.addEventListener('click', async () => {
        const user = auth.currentUser;
        if (!user) {
            window.location.href = '/login';
            return;
        }

        if (user.emailVerified) {
            setFeedback('Emailul este deja verificat.', 'success');
            return;
        }

        try {
            setButtonsDisabled(true);
            await sendEmailVerification(user);
            setFeedback('Email de verificare trimis.', 'success');
        } catch (error) {
            setFeedback(getReadableAuthError(error), 'error');
        } finally {
            setButtonsDisabled(false);
        }
    });

    resetPasswordBtn?.addEventListener('click', async () => {
        const user = auth.currentUser;
        if (!user?.email) {
            window.location.href = '/login';
            return;
        }

        try {
            setButtonsDisabled(true);
            await sendPasswordResetEmail(auth, user.email);
            setFeedback('Email pentru resetarea parolei trimis.', 'success');
        } catch (error) {
            setFeedback(getReadableAuthError(error), 'error');
        } finally {
            setButtonsDisabled(false);
        }
    });

    logoutBtn?.addEventListener('click', async () => {
        try {
            setButtonsDisabled(true);
            await signOut(auth);
            window.location.href = '/login';
        } catch (error) {
            setFeedback(getReadableAuthError(error), 'error');
            setButtonsDisabled(false);
        }
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAccountPage);
} else {
    initAccountPage();
}
