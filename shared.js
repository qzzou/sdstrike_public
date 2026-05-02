// SDStrike data layer. Pages import everything Firebase-related from here.
//
// Two backends:
//   - Real Firebase (production) — used by default.
//   - In-memory fake — enabled when URL has `?testmode=1`. All state lives
//     on window.__TEST and tests seed/inspect via window.__TEST.* helpers.
//
// The two backends expose the SAME API surface so pages don't care which is
// active. Everything async returns a Promise.

const IS_TEST_MODE =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('testmode') === '1';

// ===== Shared utilities (work in both modes) =====

export function parseDriveUrl(url) {
  if (!url) return null;
  // https://drive.google.com/file/d/{id}/view  or .../preview  or .../edit
  let m = url.match(/\/file\/d\/([^/?#]+)/);
  if (m) return m[1];
  // https://drive.google.com/open?id={id}
  m = url.match(/[?&]id=([^&#]+)/);
  if (m) return m[1];
  return null;
}

export function driveThumbnailUrl(fileId) {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;
}

export function drivePreviewUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

// 6-char human-friendly invite code. No 0/O/1/I/L to avoid confusion.
export function generateInviteCode() {
  const charset = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += charset[Math.floor(Math.random() * charset.length)];
  }
  return out;
}

export function formatDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function formatTime(value) {
  if (!value) return '';
  // Accepts "HH:MM" strings or Date
  if (typeof value === 'string' && /^\d{1,2}:\d{2}/.test(value)) {
    const [h, m] = value.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatRelative(timestamp) {
  if (!timestamp) return '';
  const t = timestamp instanceof Date ? timestamp.getTime() : +timestamp;
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatDate(t);
}

// Hash-to-color for free-form event types. Same input -> same color.
const TYPE_PALETTE = [
  { bg: '#e8f0fe', fg: '#1a3f7a' },
  { bg: '#fef3e2', fg: '#b7600a' },
  { bg: '#e5f5ea', fg: '#1e7b42' },
  { bg: '#f1e5f9', fg: '#6b2a8a' },
  { bg: '#e0f5f5', fg: '#0e6969' },
  { bg: '#eeeeee', fg: '#444444' },
];
export function colorForType(type) {
  const s = String(type || '').toLowerCase().trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TYPE_PALETTE[h % TYPE_PALETTE.length];
}

// Very small markdown-ish renderer (newlines -> <br>, escape HTML).
export function renderText(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\n/g, '<br>');
}

// Parse external games paste. One per line:
//   YYYY-MM-DD HH:MM vs Opponent @ Location
// Blank lines ignored. Returns { ok: [...], errors: ["line 2: ..."] }
export function parseExternalGames(text) {
  const ok = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(
      /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?:\s*[ap]m)?)\s+(?:vs|@)?\s*(.+?)(?:\s+@\s+(.+))?$/i
    );
    if (!m) {
      errors.push(`line ${idx + 1}: expected "YYYY-MM-DD HH:MM vs Opponent @ Location"`);
      return;
    }
    const [, date, time, opponent, location] = m;
    ok.push({
      type: 'game',
      date,
      time,
      opponent: opponent.replace(/^vs\s+/i, '').trim(),
      location: (location || '').trim(),
      source: 'external',
    });
  });
  return { ok, errors };
}

// ===== Backend selection =====

let backend;
if (IS_TEST_MODE) {
  backend = createFakeBackend();
  // Expose test control surface.
  if (typeof window !== 'undefined') {
    window.__TEST = backend.__test;
  }
} else {
  backend = await createFirebaseBackend();
}

export const {
  onAuthReady,
  getCurrentUser,
  signInWithGoogle,
  signInWithEmail,
  signUpWithEmail,
  signOut,
  getUser,
  updateUser,
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  findTeamByInviteCode,
  listTeamMembers,
  countTeamParents,
  listMessages,
  addMessage,
  updateMessage,
  deleteMessage,
  listSchedule,
  addScheduleEvent,
  updateScheduleEvent,
  deleteScheduleEvent,
  listClips,
  addClip,
  updateClip,
  deleteClip,
  listPendingUsers,
  listAllUsers,
  approveUser,
  rejectUser,
  assignCoach,
} = backend;

// ===== In-memory fake backend (test mode) =====

function createFakeBackend() {
  const state = {
    currentUserUid: null,
    users: {}, // uid -> { uid, email, displayName, role, teamMemberships, requestedRole, requestedTeamId }
    teams: {}, // teamId -> { id, name, ageGroup, coachIds, coachId, coachName, activeInviteCode, inviteExpiresAt, inviteGeneratedBy, createdAt }
    messages: {}, // teamId -> [{ id, body, authorId, authorName, createdAt, updatedAt }]
    schedule: {}, // teamId -> [{ id, type, date, time, location, opponent, source, externalUrl, notes }]
    clips: {}, // teamId -> [{ id, title, driveUrl, driveFileId, thumbnailUrl, commentary, order }]
  };

  const authListeners = new Set();
  let authReady = false;
  // In test mode, auth-ready does NOT auto-fire. Tests must call
  // __TEST.signInAs(uid) or __TEST.ready() to trigger the initial callback.
  // This avoids a race where the page redirects to signin.html before the
  // test has had a chance to seed state.
  function fireAuth() {
    if (!authReady) return;
    const user = state.currentUserUid ? state.users[state.currentUserUid] || null : null;
    authListeners.forEach((cb) => cb(user));
  }

  function genId() {
    return 'id_' + Math.random().toString(36).slice(2, 10);
  }

  const api = {
    onAuthReady(cb) {
      authListeners.add(cb);
      if (authReady) {
        const user = state.currentUserUid ? state.users[state.currentUserUid] || null : null;
        cb(user);
      }
      return () => authListeners.delete(cb);
    },
    getCurrentUser() {
      return state.currentUserUid ? state.users[state.currentUserUid] || null : null;
    },
    async signInWithGoogle() {
      // In test mode, use __TEST.signInAs instead.
      throw new Error('signInWithGoogle not available in test mode; use __TEST.signInAs');
    },
    async signInWithEmail(email /*, password */) {
      const found = Object.values(state.users).find((u) => u.email === email);
      if (!found) throw new Error('user not found');
      state.currentUserUid = found.uid;
      fireAuth();
      return found;
    },
    async signUpWithEmail(email, password, displayName) {
      const uid = 'uid_' + email.replace(/[^a-z0-9]/gi, '_');
      state.users[uid] = {
        uid,
        email,
        displayName: displayName || email,
        role: 'pending',
        teamMemberships: {},
      };
      state.currentUserUid = uid;
      fireAuth();
      return state.users[uid];
    },
    async signOut() {
      state.currentUserUid = null;
      fireAuth();
    },
    async getUser(uid) {
      return state.users[uid] ? { ...state.users[uid] } : null;
    },
    async updateUser(uid, partial) {
      if (!state.users[uid]) state.users[uid] = { uid };
      state.users[uid] = { ...state.users[uid], ...partial };
      return state.users[uid];
    },
    async listTeams() {
      return Object.values(state.teams).map((t) => ({ ...t }));
    },
    async getTeam(teamId) {
      return state.teams[teamId] ? { ...state.teams[teamId] } : null;
    },
    async createTeam({ name, ageGroup, season, year }) {
      const id = genId();
      state.teams[id] = {
        id,
        name,
        ageGroup,
        season: season || '',
        year: year || '',
        coachIds: [],
        createdAt: Date.now(),
        activeInviteCode: null,
        inviteExpiresAt: null,
      };
      return state.teams[id];
    },
    async updateTeam(teamId, partial) {
      if (!state.teams[teamId]) throw new Error('team not found');
      state.teams[teamId] = { ...state.teams[teamId], ...partial };
      return state.teams[teamId];
    },
    async findTeamByInviteCode(code) {
      const now = Date.now();
      const t = Object.values(state.teams).find(
        (x) => x.activeInviteCode === code && x.inviteExpiresAt && x.inviteExpiresAt > now
      );
      return t ? { ...t } : null;
    },
    async listTeamMembers(teamId) {
      return Object.values(state.users)
        .filter((u) => {
          const m = u.teamMemberships?.[teamId];
          return m === 'player' || m === 'coach';
        })
        .map((u) => ({ ...u }));
    },
    async countTeamParents(teamId) {
      return Object.values(state.users).filter(
        (u) => u.teamMemberships?.[teamId] === 'parent'
      ).length;
    },
    async listMessages(teamId) {
      return [...(state.messages[teamId] || [])].sort(
        (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
      );
    },
    async addMessage(teamId, { body, authorId, authorName }) {
      const msg = {
        id: genId(),
        body,
        authorId,
        authorName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      (state.messages[teamId] ||= []).push(msg);
      return msg;
    },
    async updateMessage(teamId, id, partial) {
      const list = state.messages[teamId] || [];
      const m = list.find((x) => x.id === id);
      if (!m) throw new Error('message not found');
      Object.assign(m, partial, { updatedAt: Date.now() });
      return m;
    },
    async deleteMessage(teamId, id) {
      state.messages[teamId] = (state.messages[teamId] || []).filter((x) => x.id !== id);
    },
    async listSchedule(teamId) {
      return [...(state.schedule[teamId] || [])].sort((a, b) =>
        String(a.date).localeCompare(String(b.date))
      );
    },
    async addScheduleEvent(teamId, event) {
      const e = { id: genId(), source: 'custom', ...event };
      (state.schedule[teamId] ||= []).push(e);
      return e;
    },
    async updateScheduleEvent(teamId, id, partial) {
      const list = state.schedule[teamId] || [];
      const e = list.find((x) => x.id === id);
      if (!e) throw new Error('event not found');
      Object.assign(e, partial);
      return e;
    },
    async deleteScheduleEvent(teamId, id) {
      state.schedule[teamId] = (state.schedule[teamId] || []).filter((x) => x.id !== id);
    },
    async listClips(teamId) {
      return [...(state.clips[teamId] || [])].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0)
      );
    },
    async addClip(teamId, clip) {
      const c = { id: genId(), order: (state.clips[teamId]?.length || 0), ...clip };
      (state.clips[teamId] ||= []).push(c);
      return c;
    },
    async updateClip(teamId, id, partial) {
      const list = state.clips[teamId] || [];
      const c = list.find((x) => x.id === id);
      if (!c) throw new Error('clip not found');
      Object.assign(c, partial);
      return c;
    },
    async deleteClip(teamId, id) {
      state.clips[teamId] = (state.clips[teamId] || []).filter((x) => x.id !== id);
    },
    async listPendingUsers() {
      return Object.values(state.users)
        .filter((u) => u.role === 'pending')
        .map((u) => ({ ...u }));
    },
    async listAllUsers() {
      return Object.values(state.users).map((u) => ({ ...u }));
    },
    async approveUser(uid, { role, teamId, membershipType }) {
      const u = state.users[uid];
      if (!u) throw new Error('user not found');
      u.role = role;
      if (teamId) {
        u.teamMemberships = { ...(u.teamMemberships || {}), [teamId]: membershipType || 'player' };
      }
      return u;
    },
    async rejectUser(uid) {
      const u = state.users[uid];
      if (!u) throw new Error('user not found');
      u.role = 'rejected';
      return u;
    },
    async assignCoach(teamId, uid) {
      const team = state.teams[teamId];
      const user = state.users[uid];
      if (!team || !user) throw new Error('team or user not found');
      team.coachIds = Array.from(new Set([...(team.coachIds || []), uid]));
      team.coachId = uid; // legacy compat
      team.coachName = user.displayName;
      user.role = 'coach';
      user.teamMemberships = { ...(user.teamMemberships || {}), [teamId]: 'coach' };
      return { team, user };
    },
    // Test-only surface.
    __test: {
      reset() {
        state.currentUserUid = null;
        state.users = {};
        state.teams = {};
        state.messages = {};
        state.schedule = {};
        state.clips = {};
      },
      seed(partial) {
        if (partial.users) Object.assign(state.users, partial.users);
        if (partial.teams) Object.assign(state.teams, partial.teams);
        if (partial.messages) Object.assign(state.messages, partial.messages);
        if (partial.schedule) Object.assign(state.schedule, partial.schedule);
        if (partial.clips) Object.assign(state.clips, partial.clips);
      },
      signInAs(uid) {
        state.currentUserUid = uid;
        authReady = true;
        fireAuth();
      },
      // Fire auth-ready with the current user (may be null). Used when a test
      // wants to exercise the "no user" branch (e.g. redirect to signin).
      ready() {
        authReady = true;
        fireAuth();
      },
      getState() {
        return JSON.parse(JSON.stringify(state));
      },
    },
  };

  return api;
}

// ===== Real Firebase backend =====

async function createFirebaseBackend() {
  const [
    { initializeApp },
    {
      getAuth,
      GoogleAuthProvider,
      signInWithPopup,
      signInWithEmailAndPassword,
      createUserWithEmailAndPassword,
      updateProfile,
      signOut: fbSignOut,
      onAuthStateChanged,
    },
    {
      getFirestore,
      doc,
      getDoc,
      setDoc,
      updateDoc,
      deleteDoc,
      collection,
      getDocs,
      query,
      where,
      orderBy,
      addDoc,
      serverTimestamp,
      Timestamp,
    },
  ] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js'),
  ]);

  const firebaseConfig = {
    apiKey: 'AIzaSyBvbspciyWNFHljZPvKTvW47Z0dfQwSrzM',
    authDomain: 'sdstrike-4f344.firebaseapp.com',
    projectId: 'sdstrike-4f344',
    storageBucket: 'sdstrike-4f344.firebasestorage.app',
    messagingSenderId: '828937445096',
    appId: '1:828937445096:web:1041315fe97bde3744735d',
  };

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  function tsToMillis(v) {
    if (!v) return null;
    if (v instanceof Timestamp) return v.toMillis();
    if (v.toMillis) return v.toMillis();
    if (v.seconds) return v.seconds * 1000;
    return +v;
  }

  function normalizeUser(snap) {
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      uid: snap.id,
      email: d.email,
      displayName: d.displayName,
      role: d.role || 'pending',
      chosenRole: d.chosenRole || '',
      teamMemberships: d.teamMemberships || {},
      requestedRole: d.requestedRole,
      requestedTeamId: d.requestedTeamId,
    };
  }

  function normalizeTeam(snap) {
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      id: snap.id,
      name: d.name,
      ageGroup: d.ageGroup,
      coachIds: d.coachIds || (d.coachId ? [d.coachId] : []),
      coachId: d.coachId,
      coachName: d.coachName,
      activeInviteCode: d.activeInviteCode || null,
      inviteExpiresAt: tsToMillis(d.inviteExpiresAt),
      inviteGeneratedBy: d.inviteGeneratedBy || null,
      createdAt: tsToMillis(d.createdAt),
      season: d.season || '',
      year: d.year || '',
      archived: d.archived || false,
      archivedAt: tsToMillis(d.archivedAt),
      trashed: d.trashed || false,
      trashedAt: tsToMillis(d.trashedAt),
      permanentlyDeleted: d.permanentlyDeleted || false,
    };
  }

  return {
    onAuthReady(cb) {
      return onAuthStateChanged(auth, async (u) => {
        if (!u) return cb(null);
        try {
          const snap = await getDoc(doc(db, 'users', u.uid));
          cb(normalizeUser(snap) || { uid: u.uid, email: u.email, displayName: u.displayName, role: 'pending', chosenRole: '', teamMemberships: {} });
        } catch (err) {
          console.error('Firestore user read failed:', err);
          cb({ uid: u.uid, email: u.email, displayName: u.displayName, role: 'pending', chosenRole: '', teamMemberships: {} });
        }
      });
    },
    getCurrentUser() {
      const u = auth.currentUser;
      return u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null;
    },
    async signInWithGoogle() {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      // Best-effort: create user doc if first time. Don't block sign-in if Firestore write fails.
      try {
        const userRef = doc(db, 'users', cred.user.uid);
        const snap = await getDoc(userRef);
        if (!snap.exists()) {
          await setDoc(userRef, {
            uid: cred.user.uid,
            email: cred.user.email,
            displayName: cred.user.displayName || cred.user.email,
            role: 'pending',
            teamMemberships: {},
            createdAt: serverTimestamp(),
          });
        }
      } catch (err) {
        console.warn('Could not create/read user doc after Google sign-in:', err);
      }
      return cred.user;
    },
    async signInWithEmail(email, password) {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      return cred.user;
    },
    async signUpWithEmail(email, password, displayName) {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (displayName) await updateProfile(cred.user, { displayName });
      await setDoc(doc(db, 'users', cred.user.uid), {
        uid: cred.user.uid,
        email,
        displayName: displayName || email,
        role: 'pending',
        teamMemberships: {},
        createdAt: serverTimestamp(),
      });
      return cred.user;
    },
    async signOut() {
      await fbSignOut(auth);
    },
    async getUser(uid) {
      const snap = await getDoc(doc(db, 'users', uid));
      return normalizeUser(snap);
    },
    async updateUser(uid, partial) {
      const ref = doc(db, 'users', uid);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await updateDoc(ref, partial);
      } else {
        await setDoc(ref, { uid, ...partial });
      }
      const fresh = await getDoc(ref);
      return normalizeUser(fresh);
    },
    async listTeams() {
      const snap = await getDocs(collection(db, 'teams'));
      return snap.docs.map(normalizeTeam);
    },
    async getTeam(teamId) {
      const snap = await getDoc(doc(db, 'teams', teamId));
      return normalizeTeam(snap);
    },
    async createTeam({ name, ageGroup, season, year }) {
      const ref = await addDoc(collection(db, 'teams'), {
        name,
        ageGroup,
        season: season || '',
        year: year || '',
        coachIds: [],
        createdAt: serverTimestamp(),
      });
      const snap = await getDoc(ref);
      return normalizeTeam(snap);
    },
    async updateTeam(teamId, partial) {
      const patch = { ...partial };
      if (patch.inviteExpiresAt && typeof patch.inviteExpiresAt === 'number') {
        patch.inviteExpiresAt = Timestamp.fromMillis(patch.inviteExpiresAt);
      }
      await updateDoc(doc(db, 'teams', teamId), patch);
      const snap = await getDoc(doc(db, 'teams', teamId));
      return normalizeTeam(snap);
    },
    async findTeamByInviteCode(code) {
      const q = query(collection(db, 'teams'), where('activeInviteCode', '==', code));
      const snap = await getDocs(q);
      const now = Date.now();
      for (const d of snap.docs) {
        const team = normalizeTeam(d);
        if (team.inviteExpiresAt && team.inviteExpiresAt > now) return team;
      }
      return null;
    },
    async listTeamMembers(teamId) {
      const snap = await getDocs(collection(db, 'users'));
      return snap.docs
        .map((d) => ({ uid: d.id, ...d.data() }))
        .filter((u) => {
          const m = u.teamMemberships?.[teamId];
          return m === 'player' || m === 'coach';
        });
    },
    async countTeamParents(teamId) {
      const snap = await getDocs(collection(db, 'users'));
      return snap.docs.filter((d) => d.data().teamMemberships?.[teamId] === 'parent').length;
    },
    async listMessages(teamId) {
      const q = query(
        collection(db, 'teams', teamId, 'messages'),
        orderBy('createdAt', 'desc')
      );
      const snap = await getDocs(q);
      return snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
        createdAt: tsToMillis(d.data().createdAt),
        updatedAt: tsToMillis(d.data().updatedAt),
      }));
    },
    async addMessage(teamId, { body, authorId, authorName }) {
      const ref = await addDoc(collection(db, 'teams', teamId, 'messages'), {
        body,
        authorId,
        authorName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return { id: ref.id, body, authorId, authorName, createdAt: Date.now() };
    },
    async updateMessage(teamId, id, partial) {
      await updateDoc(doc(db, 'teams', teamId, 'messages', id), {
        ...partial,
        updatedAt: serverTimestamp(),
      });
      return { id, ...partial };
    },
    async deleteMessage(teamId, id) {
      await deleteDoc(doc(db, 'teams', teamId, 'messages', id));
    },
    async listSchedule(teamId) {
      const q = query(collection(db, 'teams', teamId, 'schedule'), orderBy('date'));
      const snap = await getDocs(q);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async addScheduleEvent(teamId, event) {
      const ref = await addDoc(collection(db, 'teams', teamId, 'schedule'), {
        source: 'custom',
        ...event,
        createdAt: serverTimestamp(),
      });
      return { id: ref.id, ...event };
    },
    async updateScheduleEvent(teamId, id, partial) {
      await updateDoc(doc(db, 'teams', teamId, 'schedule', id), partial);
      return { id, ...partial };
    },
    async deleteScheduleEvent(teamId, id) {
      await deleteDoc(doc(db, 'teams', teamId, 'schedule', id));
    },
    async listClips(teamId) {
      const snap = await getDocs(collection(db, 'teams', teamId, 'clips'));
      return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    async addClip(teamId, clip) {
      const fileId = clip.driveFileId || parseDriveUrl(clip.driveUrl);
      const ref = await addDoc(collection(db, 'teams', teamId, 'clips'), {
        ...clip,
        driveFileId: fileId,
        createdAt: serverTimestamp(),
      });
      return { id: ref.id, ...clip, driveFileId: fileId };
    },
    async updateClip(teamId, id, partial) {
      const patch = { ...partial };
      if (patch.driveUrl) patch.driveFileId = parseDriveUrl(patch.driveUrl);
      await updateDoc(doc(db, 'teams', teamId, 'clips', id), patch);
      return { id, ...patch };
    },
    async deleteClip(teamId, id) {
      await deleteDoc(doc(db, 'teams', teamId, 'clips', id));
    },
    async listPendingUsers() {
      const q = query(collection(db, 'users'), where('role', '==', 'pending'));
      const snap = await getDocs(q);
      return snap.docs.map((d) => normalizeUser(d));
    },
    async listAllUsers() {
      const snap = await getDocs(collection(db, 'users'));
      return snap.docs.map((d) => normalizeUser(d)).filter(Boolean);
    },
    async approveUser(uid, { role, teamId, membershipType }) {
      const ref = doc(db, 'users', uid);
      const snap = await getDoc(ref);
      const existing = snap.exists() ? snap.data() : {};
      const teamMemberships = { ...(existing.teamMemberships || {}) };
      if (teamId) teamMemberships[teamId] = membershipType || 'player';
      await updateDoc(ref, { role, teamMemberships });
      const fresh = await getDoc(ref);
      return normalizeUser(fresh);
    },
    async rejectUser(uid) {
      await updateDoc(doc(db, 'users', uid), { role: 'rejected' });
    },
    async assignCoach(teamId, uid) {
      const teamRef = doc(db, 'teams', teamId);
      const userRef = doc(db, 'users', uid);
      const [teamSnap, userSnap] = await Promise.all([getDoc(teamRef), getDoc(userRef)]);
      const team = normalizeTeam(teamSnap);
      const user = normalizeUser(userSnap);
      const coachIds = Array.from(new Set([...(team.coachIds || []), uid]));
      await updateDoc(teamRef, {
        coachIds,
        coachId: uid,
        coachName: user?.displayName || '',
      });
      const teamMemberships = { ...(user?.teamMemberships || {}), [teamId]: 'coach' };
      await updateDoc(userRef, { role: 'coach', teamMemberships });
      return { team: { ...team, coachIds, coachId: uid }, user: { ...user, role: 'coach', teamMemberships } };
    },
  };
}
