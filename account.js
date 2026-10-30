/* Firebase sign-in + Firestore access for Life Tracker.
 * app.js talks to this through the global `Account`; it never touches Firebase directly.
 * Passwords are handled by Firebase Authentication only — nothing password-related is stored in Firestore. */
'use strict';

const Account = (() => {
  let auth, db, onChange = () => {}, busy = false;

  const FRIENDLY = {
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'Wrong email or password.',
    'auth/invalid-email': 'That email address does not look right.',
    'auth/email-already-in-use': 'That email is already registered. Try signing in.',
    'auth/weak-password': 'Use a password of at least 8 characters.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/requires-recent-login': 'Please sign in again, then retry.',
    'auth/network-request-failed': 'Network problem. Check your connection.',
    'permission-denied': 'You do not have permission to do that.'
  };
  const fail = e => { throw new Error(FRIENDLY[e.code] || e.message || 'Something went wrong.'); };
  const lower = s => String(s || '').trim().toLowerCase();

  async function profileOf(user) {
    const snap = await db.doc('members/' + user.uid).get();
    if (!snap.exists) return null;
    const d = snap.data();
    return { uid: user.uid, email: user.email, userName: d.userName, role: d.role || 'user', gender: d.gender || '' };
  }

  async function emit(user) {
    if (!user) return onChange(null);
    let profile = null;
    try { profile = await profileOf(user); } catch (e) { /* treated as not set up */ }
    if (!profile) {
      await auth.signOut();
      return onChange(null, 'This account is not set up. Ask the admin to invite your email, then register.');
    }
    onChange(profile);
  }

  return {
    configured: () => !!(window.APP_CONFIG?.firebase?.apiKey && window.APP_CONFIG?.firebase?.projectId),

    init(handler) {
      onChange = handler;
      firebase.initializeApp(window.APP_CONFIG.firebase);
      auth = firebase.auth();
      db = firebase.firestore();
      auth.onAuthStateChanged(user => { if (!busy) emit(user); });
    },

    token: async () => {
      if (!auth.currentUser) throw new Error('Please sign in.');
      return auth.currentUser.getIdToken();
    },

    async signIn(email, password) {
      try { await auth.signInWithEmailAndPassword(lower(email), password); } catch (e) { fail(e); }
    },

    /** Invite-only: the email must already be in /invites. Rolls the new login back if anything fails. */
    async register({ userName, email, password, gender }) {
      email = lower(email); userName = String(userName || '').trim();
      if (!['female', 'male', 'other'].includes(gender)) throw new Error('Please select a gender.');
      if (!/^[A-Za-z0-9_-]{3,30}$/.test(userName)) throw new Error('Username: 3–30 letters, numbers, _ or -, no spaces.');
      busy = true;
      let cred;
      try {
        try { cred = await auth.createUserWithEmailAndPassword(email, password); } catch (e) { fail(e); }
        try {
          const invite = await db.doc('invites/' + email).get();
          if (!invite.exists) throw new Error('This email has not been invited. Ask the admin to invite it first.');
          const taken = await db.doc('usernames/' + userName.toLowerCase()).get();
          if (taken.exists) throw new Error('That username is taken. Pick another.');
          const batch = db.batch();
          batch.set(db.doc('usernames/' + userName.toLowerCase()), { uid: cred.user.uid });
          batch.set(db.doc('members/' + cred.user.uid), {
            userName, email, gender, role: 'user', createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          await batch.commit();
        } catch (e) {
          await cred.user.delete().catch(() => {});
          throw e.code ? new Error(FRIENDLY[e.code] || e.message) : e;
        }
      } finally { busy = false; }
      await emit(auth.currentUser);
    },

    async resetPassword(email) {
      try { await auth.sendPasswordResetEmail(lower(email)); } catch (e) { fail(e); }
    },

    /** Firebase requires re-entering the current password before it will change it. */
    async changePassword(current, next) {
      const user = auth.currentUser;
      try {
        await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, current));
        await user.updatePassword(next);
      } catch (e) { fail(e); }
    },

    signOut: () => auth.signOut(),

    /** document_link rows for one user, oldest year first. */
    async listYears(uid) {
      try {
        const snap = await db.collection('document_link').where('userId', '==', uid).get();
        return snap.docs.map(d => d.data()).sort((a, b) => a.year - b.year);
      } catch (e) { fail(e); }
    },

    /* ----- admin ----- */
    async listMembers() {
      try {
        const snap = await db.collection('members').get();
        return snap.docs.map(d => ({ uid: d.id, ...d.data() })).sort((a, b) => a.userName.localeCompare(b.userName));
      } catch (e) { fail(e); }
    },
    async listInvites() {
      try { return (await db.collection('invites').get()).docs.map(d => d.data()); } catch (e) { fail(e); }
    },
    async addInvite(email) {
      email = lower(email);
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('That email address does not look right.');
      try {
        await db.doc('invites/' + email).set({ email, invitedAt: firebase.firestore.FieldValue.serverTimestamp() });
      } catch (e) { fail(e); }
    },
    async removeInvite(email) {
      try { await db.doc('invites/' + lower(email)).delete(); } catch (e) { fail(e); }
    },
    async removeLink(uid, year) {
      try { await db.doc(`document_link/${uid}_${year}`).delete(); } catch (e) { fail(e); }
    }
  };
})();
