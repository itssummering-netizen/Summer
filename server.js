require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { google } = require('googleapis');
const cookieSession = require('cookie-session');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const { Mutex } = require('async-mutex');

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const LOCAL_UI_ONLY = process.env.LOCAL_UI_ONLY === '1' || process.argv.includes('--ui-only');

// ===== MongoDB Connection =====
const MONGODB_URI = process.env.MONGODB_URI;
// Phải khai báo dbConnect ở phạm vi module — nếu nằm trong if/else, các route gọi dbConnect() sẽ ReferenceError và request (đặc biệt trên Vercel) treo không trả lời.
mongoose.set('bufferCommands', true);
mongoose.set('bufferTimeoutMS', 30000);

let isConnected = false;
async function dbConnect() {
  if (LOCAL_UI_ONLY) return;
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured');
  }
  if (isConnected) return;
  if (mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }
  console.log('  ⏳ Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });
  isConnected = true;
  console.log('  ✓ MongoDB Connected');
}

if (LOCAL_UI_ONLY) {
  console.log('  ⚙ LOCAL_UI_ONLY=1 -> Skip Mongo/Drive/SMTP for UI testing');
} else if (!MONGODB_URI) {
  console.error('  ✕ MONGODB_URI is missing in Environment Variables!');
} else {
  dbConnect().catch(err => console.error('Initial DB Connect Error:', err.message));
}

const AccountSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  name: String,
  avatar: String,
  userId: String
});
const UserAccount = mongoose.model('UserAccount', AccountSchema);

const MetaSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  groups: Array,
  files: Array
});
const UserMeta = mongoose.model('UserMeta', MetaSchema);

const SpareSchema = new mongoose.Schema({
  id: { type: String, default: 'spare_pool', unique: true },
  data: Object
}, { timestamps: true });
const SpareMeta = mongoose.model('SpareMeta', SpareSchema);

const OtpSchema = new mongoose.Schema({
  email: { type: String, unique: true, index: true },
  otp: String,
  name: String,
  expiresAt: { type: Date, index: { expires: 0 } }
}, { timestamps: true });
const OtpCode = mongoose.model('OtpCode', OtpSchema);

// ===== Paths (For Vercel compat, we only use /tmp for temp files) =====
const UPLOADS_DIR = path.join('/tmp', 'temp_uploads');
const THUMBS_CACHE_DIR = path.join('/tmp', 'thumbnails_cache');
const CREDS_FILE = path.join(__dirname, 'credentials.json');
const ADMIN_TOKEN_FILE = path.join(__dirname, 'token.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(THUMBS_CACHE_DIR)) fs.mkdirSync(THUMBS_CACHE_DIR, { recursive: true });

// ===== Session Setup =====
app.use(cookieSession({
  name: 'storage_session',
  keys: [process.env.SESSION_SECRET || 'fallback_secret_key_123'],
  maxAge: 30 * 24 * 60 * 1000 // 30 days
}));

app.post('/api/admin/ensure-spare', async (req, res) => {
  try {
    await dbConnect();
    if (!adminDriveClient) initAdminDrive();
    if (!adminDriveClient) {
      return res.status(503).json({
        ok: false,
        error: 'Admin Google Drive chưa kết nối. Kiểm tra GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN trên Vercel.'
      });
    }
    await ensureSpareFolder();
    const spare = await SpareMeta.findOne({ id: 'spare_pool' });
    const ready = !!(spare?.data?.folderId);
    res.json({ ok: true, spareReady: ready, folderId: spare?.data?.folderId || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== API: Files & Groups =====
const SMTP_EMAIL = (process.env.SMTP_EMAIL || '').trim();
const SMTP_PASSWORD = (process.env.SMTP_PASSWORD || '').replace(/\s+/g, '');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: SMTP_EMAIL || 'example@gmail.com',
    pass: SMTP_PASSWORD || 'your_app_password'
  }
});

// Remove otpStore - will use session instead

// ===== Admin Drive Client =====
let adminOAuthClient = null;
let adminDriveClient = null;

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`  ✕ Invalid JSON in env ${name}:`, e.message);
    return null;
  }
}

function loadGoogleOAuthCreds() {
  const fromEnv = parseJsonEnv('GOOGLE_OAUTH_CREDENTIALS_JSON');
  if (fromEnv) {
    const w = fromEnv.web || fromEnv.installed || {};
    if (w.client_id && w.client_secret) return { client_id: w.client_id, client_secret: w.client_secret };
  }
  const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (id && secret) return { client_id: id, client_secret: secret };
  if (fs.existsSync(CREDS_FILE)) {
    const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
    const w = creds.web || creds.installed || {};
    if (w.client_id && w.client_secret) return { client_id: w.client_id, client_secret: w.client_secret };
  }
  return null;
}

function loadGoogleToken() {
  const fromEnv = parseJsonEnv('GOOGLE_OAUTH_TOKEN_JSON');
  if (fromEnv && fromEnv.refresh_token) return fromEnv;
  const rt = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
  if (rt) {
    const token = { refresh_token: rt, token_type: 'Bearer' };
    const at = (process.env.GOOGLE_ACCESS_TOKEN || '').trim();
    if (at) token.access_token = at;
    const exp = (process.env.GOOGLE_TOKEN_EXPIRY_MS || '').trim();
    if (exp && /^\d+$/.test(exp)) token.expiry_date = Number(exp);
    return token;
  }
  if (fs.existsSync(ADMIN_TOKEN_FILE)) {
    return JSON.parse(fs.readFileSync(ADMIN_TOKEN_FILE, 'utf-8'));
  }
  return null;
}

function initAdminDrive() {
  try {
    const oauthCreds = loadGoogleOAuthCreds();
    const token = loadGoogleToken();

    if (!oauthCreds || !token || !token.refresh_token) {
      console.log('  ⚠ Admin Google Drive: missing credentials or refresh_token.');
      console.log('     On Vercel, set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
      console.log('     (or GOOGLE_OAUTH_CREDENTIALS_JSON + GOOGLE_OAUTH_TOKEN_JSON).');
      return;
    }

    const { client_id, client_secret } = oauthCreds;
    adminOAuthClient = new google.auth.OAuth2(client_id, client_secret, `${BASE_URL}/auth/callback`);
    adminOAuthClient.setCredentials(token);

    if (!process.env.VERCEL) {
      adminOAuthClient.on('tokens', (newTokens) => {
        if (!fs.existsSync(ADMIN_TOKEN_FILE)) return;
        try {
          const stored = JSON.parse(fs.readFileSync(ADMIN_TOKEN_FILE, 'utf-8'));
          fs.writeFileSync(ADMIN_TOKEN_FILE, JSON.stringify({ ...stored, ...newTokens }, null, 2));
        } catch (e) {
          console.error('  ✕ Could not persist token.json:', e.message);
        }
      });
    }

    adminDriveClient = google.drive({ version: 'v3', auth: adminOAuthClient });
    console.log('  ✓ Admin Google Drive Connected');
  } catch (e) {
    console.error('  ✕ Admin Google Drive Connection Failed:', e.message);
  }
}

// ===== Metadata (Per User & Guest) =====
function makeDefaultFiles() {
  return [
    { id: 'folder_guest', name: 'Folder', type: 'folder', size: 0, sizeFormatted: '—', uploadedAt: new Date().toISOString(), hidden: false, position: {x: -160, y: -60}, parentFolder: null, groupId: 'default', isGuest: true },
    { id: 'note_guest', name: 'Note', type: 'note', size: 0, sizeFormatted: '0 B', uploadedAt: new Date().toISOString(), hidden: false, position: {x: 160, y: -50}, content: '', parentFolder: null, groupId: 'default', isGuest: true },
    { id: 'image_guest', name: 'image_0.jpg', type: 'image', size: 0, sizeFormatted: '0 B', uploadedAt: new Date().toISOString(), hidden: false, position: {x: 0, y: 220}, parentFolder: null, groupId: 'default', isGuest: true }
  ];
}
const guestMeta = {
  groups: [{ id: 'default', name: 'Default' }],
  files: makeDefaultFiles()
};

const userMetaInitMutexes = new Map();
function mutexForUserMeta(userId) {
  let m = userMetaInitMutexes.get(userId);
  if (!m) {
    m = new Mutex();
    userMetaInitMutexes.set(userId, m);
  }
  return m;
}

/** User mới từng bị race: /api/files gọi trước khi initializeUserMeta ghi DB → []. Chờ init (kèm mutex) rồi mới trả meta. */
async function ensureUserMetaReady(userId) {
  if (!userId) return;
  if (await UserMeta.findOne({ userId })) return;
  const user = await UserAccount.findOne({ userId });
  if (!user) return;
  const mutex = mutexForUserMeta(userId);
  await mutex.runExclusive(async () => {
    if (await UserMeta.findOne({ userId })) return;
    await initializeUserMeta(user);
  });
}

async function readMeta(userId) {
  if (!userId) return { ...guestMeta, files: makeDefaultFiles() };
  await ensureUserMetaReady(userId);
  const meta = await UserMeta.findOne({ userId });
  if (!meta) return { groups: [{ id: 'default', name: 'Default' }], files: [] };
  return meta;
}

async function writeMeta(userId, data) {
  if (LOCAL_UI_ONLY) {
    guestMeta.groups = data.groups;
    guestMeta.files = data.files;
    return;
  }
  if (!userId) return; 
  await UserMeta.updateOne({ userId }, { groups: data.groups, files: data.files }, { upsert: true });
}

// ===== Google Drive Folder Logic =====
async function getOrCreateAdminRoot() {
  if (!adminDriveClient) throw new Error("Admin Drive not initialized");
  const search = await adminDriveClient.files.list({
    q: "name='Storage App' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id)', spaces: 'drive'
  });
  if (search.data.files.length > 0) return search.data.files[0].id;
  const folder = await adminDriveClient.files.create({
    requestBody: { name: 'Storage App', mimeType: 'application/vnd.google-apps.folder' }, fields: 'id'
  });
  return folder.data.id;
}

function driveQueryEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function getOrCreateUserFolder(user) {
  const rootId = await getOrCreateAdminRoot();
  const folderName = `Storage_${user.email}`;
  const safeName = driveQueryEscape(folderName);
  const search = await adminDriveClient.files.list({
    q: `name='${safeName}' and '${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)', spaces: 'drive'
  });
  if (search.data.files.length > 0) return search.data.files[0].id;
  const folder = await adminDriveClient.files.create({
    requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [rootId] }, fields: 'id'
  });
  return folder.data.id;
}

// Lease ngắn: chỉ chống race song song; crash giữa chừng được recover bằng STUCK_CREATING_MS / xóa lock.
const SPARE_BUILD_LEASE_MS = 3 * 60 * 1000;
const STALE_SPARE_BUILD_MS = 10 * 60 * 1000;
/** Nếu trạng thái `creating` mà không có folderId quá lâu → coi worker chết (Vercel timeout / crash), cho phép tạo lại. */
const STUCK_CREATING_MS = 2 * 60 * 1000;

/** Xóa bản ghi spare_pool bị treo (creating, chưa có folderId, updatedAt cũ). */
async function recoverStuckSpareLock() {
  const doc = await SpareMeta.findOne({ id: 'spare_pool' });
  if (!doc?.data?.folderId && doc?.data?.status === 'creating') {
    const age = Date.now() - new Date(doc.updatedAt || 0).getTime();
    if (age > STUCK_CREATING_MS) {
      console.log(`  ⚠ spare_pool: clearing stuck "creating" lock (${Math.round(age / 1000)}s old, no folderId)`);
      await SpareMeta.deleteOne({ id: 'spare_pool' });
    }
  }
}

/** Một worker duy nhất được tạo spare: khóa bằng builderUntil, tránh 2 instance Vercel tạo 2 folder trùng. */
async function tryAcquireSpareBuildLock() {
  const builderId = uuidv4();
  const builderUntil = new Date(Date.now() + SPARE_BUILD_LEASE_MS);
  const staleTime = new Date(Date.now() - STALE_SPARE_BUILD_MS);
  const stuckCreatingBefore = new Date(Date.now() - STUCK_CREATING_MS);
  const res = await SpareMeta.updateOne(
    {
      id: 'spare_pool',
      'data.folderId': { $exists: false },
      $or: [
        { 'data.builderUntil': { $exists: false } },
        { 'data.builderUntil': { $lte: new Date() } },
        { updatedAt: { $lte: staleTime } },
        // Cho phép chiếm lock nếu creating quá lâu (worker treo), kể cả builderUntil chưa hết hạn
        { $and: [{ 'data.status': 'creating' }, { updatedAt: { $lte: stuckCreatingBefore } }] }
      ]
    },
    { $set: { data: { status: 'creating', builderId, builderUntil, timestamp: Date.now() } } },
    { upsert: true }
  );
  const ack = res.upsertedCount > 0 || res.modifiedCount > 0;
  if (!ack) return null;
  const mine = await SpareMeta.findOne({ id: 'spare_pool', 'data.builderId': builderId });
  return mine ? builderId : null;
}

async function ensureSpareFolder() {
  await dbConnect(); // Đảm bảo DB đã sẵn sàng
  await recoverStuckSpareLock(); // không phụ thuộc Drive — xóa lock treo để lần sau không bị kẹt vài phút

  // Cold start Vercel: thử lại OAuth trước khi bỏ qua (trước đây return sớm → không bao giờ tạo spare).
  if (!adminDriveClient) initAdminDrive();
  if (!adminDriveClient) return;

  const sparePeek = await SpareMeta.findOne({ id: 'spare_pool' });
  // spare đang build không có folderId; chỉ khi xong mới ghi folderId → có folderId là đã sẵn sàng (kể cả bản ghi cũ không có field status)
  if (sparePeek?.data?.folderId) return;

  const lockOwner = await tryAcquireSpareBuildLock();
  if (!lockOwner) {
    return;
  }

  try {
    console.log('  🏗 Starting Spare Folder creation process...');
    if (!adminDriveClient) {
      console.log('  ⏳ adminDriveClient not ready, re-initializing...');
      initAdminDrive();
    }
    if (!adminDriveClient) {
      console.error('  ✕ adminDriveClient still not ready. Check environment variables.');
      await SpareMeta.deleteOne({ id: 'spare_pool' });
      return;
    }
    const rootId = await getOrCreateAdminRoot();
    const spareName = `Spare_Template_${uuidv4()}`;
    const folder = await adminDriveClient.files.create({
      requestBody: { name: spareName, mimeType: 'application/vnd.google-apps.folder', parents: [rootId] }, fields: 'id'
    });
    const folderId = folder.data.id;

    // Tạo các thành phần bên trong
    const sub = await adminDriveClient.files.create({
      requestBody: { name: 'Folder', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] }, fields: 'id'
    });

    const noteId = uuidv4();
    const notePath = path.join(UPLOADS_DIR, noteId + '.txt');
    fs.writeFileSync(notePath, 'Leave a little something here.');
    const noteDrive = await adminDriveClient.files.create({
      requestBody: { name: 'Note', parents: [folderId] },
      media: { mimeType: 'text/plain', body: fs.createReadStream(notePath) },
      fields: 'id'
    });
    const noteSize = fs.statSync(notePath).size;
    fs.unlinkSync(notePath);

    let imgDriveId = null;
    let imgSize = 0;
    const imagePath = path.join(__dirname, 'public', 'image_0.jpg');
    if (fs.existsSync(imagePath)) {
      const driveImg = await adminDriveClient.files.create({
        requestBody: { name: 'image_0.jpg', parents: [folderId] },
        media: { mimeType: 'image/jpeg', body: fs.createReadStream(imagePath) },
        fields: 'id'
      });
      imgDriveId = driveImg.data.id;
      imgSize = fs.statSync(imagePath).size;
    }

    const spareData = { folderId, subfolderId: sub.data.id, noteId: noteDrive.data.id, noteSize, imageId: imgDriveId, imageSize: imgSize, status: 'ready' };
    await SpareMeta.updateOne({ id: 'spare_pool' }, { $set: { data: spareData } }, { upsert: true });
    console.log('  ✓ Pre-warmed Spare Folder Ready for Next User');
  } catch (e) {
    console.error('  ✕ Failed to create spare folder:', e.message);
    await SpareMeta.deleteOne({ id: 'spare_pool' });
  }
}

/** Đồng bộ Drive sau khi đã có meta mặc định trong DB — chạy nền để verify-otp /api không chờ quá lâu (Vercel ~10s). */
async function enrichUserMetaFromDrive(user) {
  if (!adminDriveClient) return;
  const doc = await UserMeta.findOne({ userId: user.userId });
  if (!doc?.files?.length) return;
  const files = JSON.parse(JSON.stringify(doc.files));

  // Gán spare một cách nguyên tử: chỉ một user nhận được bản ghi; tránh 2 user cùng đổi tên 1 folder Drive
  const spareDoc = await SpareMeta.findOneAndDelete({
    id: 'spare_pool',
    'data.folderId': { $exists: true, $ne: null }
  });
  if (spareDoc?.data?.folderId) {
    const spare = spareDoc.data;
    console.log('  🎁 Spare folder claimed for new user, root ID:', spare.folderId);
    try {
      const folderName = `Storage_${user.email}`;
      await adminDriveClient.files.update({ fileId: spare.folderId, requestBody: { name: folderName } });

      files[0].driveFileId = spare.subfolderId;
      files[1].driveFileId = spare.noteId;
      files[1].size = spare.noteSize;
      files[1].sizeFormatted = formatFileSize(spare.noteSize);
      files[2].driveFileId = spare.imageId;
      files[2].size = spare.imageSize;
      files[2].sizeFormatted = formatFileSize(spare.imageSize);

      const imagePath = path.join(process.cwd(), 'public', 'image_0.jpg');
      if (fs.existsSync(imagePath)) {
        const thumbDriveId = await generateThumbnail(imagePath, files[2].id, 'image');
        if (thumbDriveId) files[2].driveThumbnailId = thumbDriveId;
      }

      await writeMeta(user.userId, { groups: [{ id: 'default', name: 'Default' }], files });
      void ensureSpareFolder().catch((err) => console.error('  ✕ ensureSpareFolder after assign:', err.message));
      return;
    } catch (e) {
      console.error('  ✕ Spare folder assignment failed, re-pooling and falling back:', e.message);
      try {
        await SpareMeta.updateOne(
          { id: 'spare_pool' },
          { $set: { data: { ...spare, status: 'ready' } } },
          { upsert: true }
        );
      } catch (rePoolErr) {
        console.error('  ✕ Could not restore spare to pool:', rePoolErr.message);
      }
    }
  }

  try {
    const userFolderId = await getOrCreateUserFolder(user);
    const folderDriveId = await createDriveFolder(user, 'Folder', userFolderId);
    files[0].driveFileId = folderDriveId;
    const notePath = path.join(UPLOADS_DIR, files[1].id + '.txt');
    fs.writeFileSync(notePath, files[1].content);
    const noteDriveData = await uploadToDrive(user, notePath, 'Note', 'text/plain', userFolderId);
    files[1].driveFileId = noteDriveData.id;
    files[1].size = fs.statSync(notePath).size;
    files[1].sizeFormatted = formatFileSize(files[1].size);
    fs.unlinkSync(notePath);

    const imagePath = path.join(__dirname, 'public', 'image_0.jpg');
    if (fs.existsSync(imagePath)) {
      const stats = fs.statSync(imagePath);
      files[2].size = stats.size;
      files[2].sizeFormatted = formatFileSize(stats.size);
      const driveData = await uploadToDrive(user, imagePath, 'image_0.jpg', 'image/jpeg', userFolderId);
      files[2].driveFileId = driveData.id;
      const thumbDriveId = await generateThumbnail(imagePath, files[2].id, 'image');
      if (thumbDriveId) files[2].driveThumbnailId = thumbDriveId;
    }
  } catch (e) {
    console.error('Failed to init user Drive:', e.message);
  }

  await writeMeta(user.userId, { groups: [{ id: 'default', name: 'Default' }], files });
  void ensureSpareFolder().catch((err) => console.error('  ✕ ensureSpareFolder after init:', err.message));
}

async function initializeUserMeta(user) {
  await dbConnect(); // Đảm bảo DB đã sẵn sàng
  const existing = await UserMeta.findOne({ userId: user.userId });
  if (existing) return;

  const files = [
    { id: uuidv4(), name: 'Folder', type: 'folder', size: 0, sizeFormatted: '—', uploadedAt: new Date().toISOString(), hidden: false, position: {x: 4920, y: 4880}, parentFolder: null, groupId: 'default' },
    { id: uuidv4(), name: 'Note', type: 'note', size: 0, sizeFormatted: '0 B', uploadedAt: new Date().toISOString(), hidden: false, position: {x: 5240, y: 4840}, parentFolder: null, groupId: 'default' },
    { id: uuidv4(), name: 'image_0.jpg', filename: 'image_0.jpg', type: 'image', size: 0, sizeFormatted: '0 B', uploadedAt: new Date().toISOString(), hidden: false, position: {x: 5080, y: 5060}, parentFolder: null, groupId: 'default' }
  ];

  await writeMeta(user.userId, { groups: [{ id: 'default', name: 'Default' }], files });

  if (adminDriveClient) {
    void enrichUserMetaFromDrive(user).catch((err) => console.error('  ✕ enrichUserMetaFromDrive:', err.message));
  } else {
    void ensureSpareFolder().catch((err) => console.error('  ✕ ensureSpareFolder after init:', err.message));
  }
}

// ===== Helpers =====
function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif'];
  const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv'];
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  return 'other';
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function generateThumbnail(filePath, id, fileType) {
  if (LOCAL_UI_ONLY) return null;
  if (fileType !== 'image') return null;
  const thumbPath = path.join(UPLOADS_DIR, id + '.webp');
  try {
    await sharp(filePath).resize(300, 300, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbPath);
    // Upload thumbnail to a hidden "Thumbnails" folder on Drive
    if (!adminDriveClient) return null;
    const thumbRoot = await getOrCreateThumbRoot();
    const res = await adminDriveClient.files.create({
      requestBody: { name: id + '.webp', parents: [thumbRoot] },
      media: { mimeType: 'image/webp', body: fs.createReadStream(thumbPath) },
      fields: 'id'
    });
    fs.unlinkSync(thumbPath);
    return res.data.id;
  } catch (e) { return null; }
}

async function getOrCreateThumbRoot() {
  const rootId = await getOrCreateAdminRoot();
  const search = await adminDriveClient.files.list({
    q: `name='Thumbnails' and '${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)'
  });
  if (search.data.files.length > 0) return search.data.files[0].id;
  const folder = await adminDriveClient.files.create({
    requestBody: { name: 'Thumbnails', mimeType: 'application/vnd.google-apps.folder', parents: [rootId] }, fields: 'id'
  });
  return folder.data.id;
}

// ===== Google Drive Operations =====
async function uploadToDrive(user, filePath, fileName, mimeType, parentDriveId) {
  if (LOCAL_UI_ONLY || !adminDriveClient) return { id: null };
  const root = parentDriveId || await getOrCreateUserFolder(user);
  const res = await adminDriveClient.files.create({
    requestBody: { name: fileName, parents: [root] },
    media: { mimeType: mimeType || 'application/octet-stream', body: fs.createReadStream(filePath) },
    fields: 'id, size, thumbnailLink'
  });
  return res.data;
}

async function downloadFromDrive(driveFileId) {
  if (!adminDriveClient) throw new Error("Admin Drive disconnected");
  const res = await adminDriveClient.files.get({ fileId: driveFileId, alt: 'media' }, { responseType: 'stream' });
  return res.data;
}

async function deleteFromDrive(driveFileId) {
  if (!adminDriveClient) return;
  try { await adminDriveClient.files.delete({ fileId: driveFileId }); } catch (e) { console.error('Drive delete error:', e.message); }
}

async function syncNoteToDrive(user, file, meta) {
  if (!adminDriveClient) return;
  const noteContent = file.content || '';
  const notePath = path.join(UPLOADS_DIR, file.id + '.txt');
  fs.writeFileSync(notePath, noteContent);
  
  let driveParentId = null;
  if (file.parentFolder) {
    const parentMeta = meta.files.find(f => f.id === file.parentFolder);
    if (parentMeta && parentMeta.driveFileId) driveParentId = parentMeta.driveFileId;
  }
  if (!driveParentId) driveParentId = await getOrCreateUserFolder(user);

  try {
    if (file.driveFileId) {
      await adminDriveClient.files.update({
        fileId: file.driveFileId,
        media: { mimeType: 'text/plain', body: fs.createReadStream(notePath) }
      });
    } else {
      const res = await adminDriveClient.files.create({
        requestBody: { name: file.name, parents: [driveParentId] },
        media: { mimeType: 'text/plain', body: fs.createReadStream(notePath) },
        fields: 'id'
      });
      file.driveFileId = res.data.id;
    }
    const stats = fs.statSync(notePath);
    file.size = stats.size;
    file.sizeFormatted = formatFileSize(stats.size);
  } catch (e) {
    console.error('Drive note sync error:', e.message);
  } finally {
    if (fs.existsSync(notePath)) fs.unlinkSync(notePath);
  }
}

async function createDriveFolder(user, name, parentDriveId) {
  if (LOCAL_UI_ONLY || !adminDriveClient) return null;
  const root = parentDriveId || await getOrCreateUserFolder(user);
  const res = await adminDriveClient.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [root] }, fields: 'id'
  });
  return res.data.id;
}

// ===== Express Setup =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/icons', express.static(path.join(__dirname, 'icons')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, id + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024, fields: 500, files: 100 } });

// ===== Auth Routes (Email OTP) =====
app.get('/auth/status', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  if (LOCAL_UI_ONLY && !req.session.userId) {
    const user = {
      userId: 'local-ui-user',
      name: 'Local Tester',
      email: 'local@example.com',
      avatar: '☁️'
    };
    req.session.userId = user.userId;
    req.session.user = user;
  }

  const authenticated = !!req.session.userId;
  res.json({ authenticated, user: req.session.user || null });
});

app.post('/auth/check', async (req, res) => {
  if (LOCAL_UI_ONLY) {
    return res.json({ isNew: true });
  }
  await dbConnect();
  const email = req.body.email?.toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await UserAccount.findOne({ email });
    res.json({ isNew: !user });
  } catch (err) {
    console.error('  ✕ Auth check error:', err.message);
    res.status(500).json({ error: 'Cannot check account right now. Please try again.' });
  }
});

app.post('/auth/request-otp', async (req, res) => {
  if (LOCAL_UI_ONLY) {
    return res.json({ ok: true, localUiOnly: true });
  }
  await dbConnect();
  const email = req.body.email?.toLowerCase().trim();
  const name = req.body.name?.trim();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  console.log(`  🔍 Requesting OTP for: ${email}`);
  try {
    if (!SMTP_EMAIL || !SMTP_PASSWORD) {
      console.error('  ✕ SMTP CONFIG ERROR: SMTP_EMAIL or SMTP_PASSWORD is UNDEFINED!');
      return res.status(500).json({ error: 'SMTP is not configured on server' });
    }

    await transporter.sendMail({
      from: `"Storage App" <${SMTP_EMAIL}>`,
      to: email,
      subject: 'Your Login Code',
      text: `Your login code is: ${otp}`
    });

    await OtpCode.updateOne(
      { email },
      { email, otp, name, expiresAt },
      { upsert: true }
    );

    console.log(`  ✓ OTP actually sent to ${email}`);
    res.json({ ok: true });
  } catch (err) { 
    console.error('  ✕ Email Sending Error:', err.message);
    console.error('  ✕ SMTP details:', {
      code: err.code,
      responseCode: err.responseCode,
      command: err.command,
      response: err.response
    });
    res.status(500).json({ error: 'Failed to send email. Check SMTP settings.' }); 
  }
});

app.post('/auth/verify-otp', async (req, res) => {
  if (LOCAL_UI_ONLY) {
    const email = req.body.email?.toLowerCase().trim();
    const user = {
      userId: 'local-ui-user',
      name: req.body.name?.trim() || (email ? email.split('@')[0] : 'Local User'),
      email: email || 'local@example.com',
      avatar: '☁️'
    };
    req.session.userId = user.userId;
    req.session.user = user;
    return res.json({ ok: true, user, localUiOnly: true });
  }
  await dbConnect();
  const email = req.body.email?.toLowerCase().trim();
  const otp = req.body.otp?.trim();
  
  if (!email || !otp) return res.status(400).json({ error: 'Missing fields' });

  const otpData = await OtpCode.findOne({ email });
  if (!otpData) return res.status(400).json({ error: 'No code requested for this email' });
  if (Date.now() > new Date(otpData.expiresAt).getTime()) {
    await OtpCode.deleteOne({ email });
    return res.status(400).json({ error: 'Code expired' });
  }
  if (otpData.otp !== otp) return res.status(400).json({ error: 'Incorrect code' });

  // Success - OTP can only be used once
  await OtpCode.deleteOne({ email });

  let user = await UserAccount.findOne({ email });
  if (!user) {
    user = new UserAccount({ userId: uuidv4(), name: otpData.name || email.split('@')[0], email });
    await user.save();
  }

  try {
    await ensureUserMetaReady(user.userId);
  } catch (e) {
    console.error('  ✕ ensureUserMetaReady after login:', e.message);
  }

  req.session.userId = user.userId;
  req.session.user = user;
  res.json({ ok: true, user });
});

app.post('/auth/logout', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  req.session = null;
  res.json({ ok: true });
});

app.put('/api/user/name', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const name = req.body.name?.trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (LOCAL_UI_ONLY) {
    req.session.user = req.session.user || { userId: req.session.userId };
    req.session.user.name = name;
    return res.json({ ok: true, localUiOnly: true });
  }
  await UserAccount.updateOne({ userId: req.session.userId }, { name });
  req.session.user.name = name;
  res.json({ ok: true });
});

app.put('/api/user/avatar', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const avatar = req.body.avatar;
  if (!avatar) return res.status(400).json({ error: 'Avatar required' });
  if (LOCAL_UI_ONLY) {
    req.session.user = req.session.user || { userId: req.session.userId };
    req.session.user.avatar = avatar;
    return res.json({ ok: true, localUiOnly: true });
  }
  await UserAccount.updateOne({ userId: req.session.userId }, { avatar });
  req.session.user.avatar = avatar;
  res.json({ ok: true });
});

// Auth guard middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  req.userId = req.session.userId;
  req.user = req.session.user;
  next();
}

// ===== API Routes (Guest-aware) =====
app.get('/api/groups', async (req, res) => {
  const meta = await readMeta(req.session.userId);
  res.json(meta.groups);
});

app.get('/api/files', async (req, res) => {
  const meta = await readMeta(req.session.userId);
  const groupId = req.query.groupId;
  res.json(groupId ? meta.files.filter(f => f.groupId === groupId) : meta.files);
});

app.post('/api/groups', requireAuth, async (req, res) => {
  const meta = await readMeta(req.userId);
  const group = { id: uuidv4(), name: req.body.name || 'New Group' };
  meta.groups.push(group);
  await writeMeta(req.userId, meta);
  res.json(group);
});

app.put('/api/groups/:id', requireAuth, async (req, res) => {
  const meta = await readMeta(req.userId);
  const group = meta.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) group.name = req.body.name;
  await writeMeta(req.userId, meta);
  res.json(group);
});

app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  const meta = await readMeta(req.userId);
  if (meta.groups.length <= 1) return res.status(400).json({ error: 'Cannot delete last group' });
  const groupFiles = meta.files.filter(f => f.groupId === req.params.id);
  for (const f of groupFiles) {
    if (f.driveFileId) await deleteFromDrive(f.driveFileId);
    if (f.driveThumbnailId) await deleteFromDrive(f.driveThumbnailId);
  }
  meta.files = meta.files.filter(f => f.groupId !== req.params.id);
  meta.groups = meta.groups.filter(g => g.id !== req.params.id);
  await writeMeta(req.userId, meta);
  res.json({ ok: true });
});

// ===== Direct-to-Drive Upload (Bypasses Vercel 4.5MB limit) =====

// Step 1: Server creates a resumable upload session on Google Drive, returns URL to client
app.post('/api/upload/init', requireAuth, async (req, res) => {
  try {
    if (!adminDriveClient || !adminOAuthClient) {
      return res.status(503).json({ error: 'Google Drive not connected' });
    }
    const { fileName, mimeType, fileSize, parentFolder } = req.body;

    let driveParentId = null;
    if (parentFolder) {
      const meta = await readMeta(req.userId);
      const parentMeta = meta.files.find(f => f.id === parentFolder);
      if (parentMeta && parentMeta.driveFileId) driveParentId = parentMeta.driveFileId;
    }
    if (!driveParentId) driveParentId = await getOrCreateUserFolder(req.user);

    // Create resumable upload session via Google API
    const response = await adminOAuthClient.request({
      url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(fileSize),
        'Origin': req.headers.origin || BASE_URL,
      },
      data: {
        name: fileName,
        parents: [driveParentId],
      },
    });

    const uploadUrl = response.headers?.location || response.headers?.['location'];
    if (!uploadUrl) throw new Error('No resumable upload URL returned');

    res.json({ uploadUrl });
  } catch (e) {
    console.error('Upload init error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Step 2: Client sends small thumbnail blob through server to Drive
app.post('/api/upload/thumb', requireAuth, upload.single('thumb'), async (req, res) => {
  try {
    if (!adminDriveClient) {
      if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.json({ driveThumbnailId: null });
    }
    const thumbRoot = await getOrCreateThumbRoot();
    const fileId = req.body.fileId || 'thumb';
    const driveRes = await adminDriveClient.files.create({
      requestBody: { name: fileId + '.webp', parents: [thumbRoot] },
      media: { mimeType: 'image/webp', body: fs.createReadStream(req.file.path) },
      fields: 'id'
    });
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.json({ driveThumbnailId: driveRes.data.id });
  } catch (e) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch (e2) {}
    console.error('Thumb upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Step 3: Client sends metadata after direct Drive upload is complete
app.post('/api/upload/complete', requireAuth, async (req, res) => {
  try {
    const meta = await readMeta(req.userId);
    const newFiles = req.body.files || [];
    for (const f of newFiles) {
      meta.files.push(f);
    }
    await writeMeta(req.userId, meta);
    res.json({ ok: true, files: newFiles });
  } catch (e) {
    console.error('Upload complete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Legacy upload (fallback for local dev / small files)
app.post('/api/upload', requireAuth, upload.any(), async (req, res) => {
  const meta = await readMeta(req.userId);
  const filesList = req.files.filter(f => f.fieldname === 'files');
  const newFiles = [];
  const positions = req.body.positions ? JSON.parse(req.body.positions) : [];
  const groupId = req.body.groupId || 'default';
  const parentFolder = req.body.parentFolder || null;

  let driveParentId = null;
  if (parentFolder) {
    const parentMeta = meta.files.find(f => f.id === parentFolder);
    if (parentMeta && parentMeta.driveFileId) driveParentId = parentMeta.driveFileId;
  }

  for (let i = 0; i < filesList.length; i++) {
    const file = filesList[i];
    const id = path.basename(file.filename, path.extname(file.filename));
    const fileType = getFileType(file.originalname);
    const pos = positions[i] || { x: 100 + Math.random() * 600, y: 100 + Math.random() * 400 };

    const thumbDriveId = await generateThumbnail(file.path, id, fileType);
    
    // Check for client-side thumbnail
    const clientThumb = req.files.find(f => f.fieldname === `videoThumb_${i}`);
    let finalThumbId = thumbDriveId;
    if (clientThumb) {
      const driveId = await generateThumbnail(clientThumb.path, id, 'image');
      if (driveId) finalThumbId = driveId;
      fs.unlinkSync(clientThumb.path);
    }

    let driveData;
    try {
      driveData = await uploadToDrive(req.user, file.path, file.originalname, file.mimetype, driveParentId);
    } catch (e) { driveData = { id: null }; }

    const fileMeta = {
      id, name: file.originalname, filename: file.filename, type: fileType,
      size: file.size, sizeFormatted: formatFileSize(file.size),
      uploadedAt: new Date().toISOString(), hidden: false, position: pos,
      parentFolder, groupId, driveFileId: driveData.id || null, driveThumbnailId: finalThumbId
    };
    newFiles.push(fileMeta);
    meta.files.push(fileMeta);
    if (driveData.id) { try { fs.unlinkSync(file.path); } catch (e) {} }
  }
  await writeMeta(req.userId, meta);
  res.json(newFiles);
});

app.get('/api/files/:id/thumbnail', async (req, res) => {
  const meta = await readMeta(req.session.userId);
  const file = meta.files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).end();

  // 1. Browser caching: Nếu có v= query param, cache mạnh trên trình duyệt
  if (req.query.v) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }

  // Guest mode
  if (file.isGuest) {
    const p = path.join(__dirname, 'public', 'image_0.jpg');
    return fs.existsSync(p) ? res.sendFile(p) : res.status(404).end();
  }

  if (file.driveThumbnailId) {
    const cachePath = path.join(THUMBS_CACHE_DIR, `${file.driveThumbnailId}.webp`);
    
    // 2. Server-side caching: Nếu đã có file trong /tmp thì trả về luôn
    if (fs.existsSync(cachePath)) {
      return res.sendFile(cachePath);
    }

    try {
      const stream = await downloadFromDrive(file.driveThumbnailId);
      
      // Vừa trả về cho client, vừa ghi vào cache
      const writeStream = fs.createWriteStream(cachePath);
      res.setHeader('Content-Type', 'image/webp');
      
      stream.pipe(writeStream); // Lưu vào cache
      stream.pipe(res);        // Trả về cho trình duyệt
      return;
    } catch (e) {
      console.error('Thumbnail fetch error:', e.message);
    }
  }
  res.status(404).end();
});

app.get('/api/files/:id/raw', async (req, res) => {
  const meta = await readMeta(req.session.userId);
  const file = meta.files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });

  // Browser caching cho file gốc
  if (req.query.v) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }

  if (file.isGuest) {
    const p = path.join(__dirname, 'public', file.filename || file.name);
    return fs.existsSync(p) ? res.sendFile(p) : res.status(404).end();
  }
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  if (file.driveFileId) {
    try {
      const stream = await downloadFromDrive(file.driveFileId);
      const ext = path.extname(file.name).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
        '.pdf': 'application/pdf', '.svg': 'image/svg+xml'
      };
      if (mimeMap[ext]) res.setHeader('Content-Type', mimeMap[ext]);
      stream.pipe(res);
      return;
    } catch (e) {}
  }
  res.status(404).end();
});

app.get('/api/files/:id/download', async (req, res) => {
  const meta = await readMeta(req.session.userId);
  const file = meta.files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  
  if (file.type === 'note') {
    const tmpPath = path.join(UPLOADS_DIR, file.id + '.txt');
    fs.writeFileSync(tmpPath, file.content || '');
    return res.download(tmpPath, file.name, () => { try { fs.unlinkSync(tmpPath); } catch(e) {} });
  }
  if (file.isGuest) return res.download(path.join(__dirname, 'public', file.filename));
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  if (file.driveFileId) {
    try {
      const stream = await downloadFromDrive(file.driveFileId);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
      stream.pipe(res);
      return;
    } catch (e) {}
  }
  res.status(404).end();
});

app.put('/api/files/:id', requireAuth, async (req, res) => {
  const meta = await readMeta(req.userId);
  const file = meta.files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });

  const contentChanged = req.body.content !== undefined && req.body.content !== file.content;
  const nameChanged = req.body.name !== undefined && req.body.name !== file.name;

  ['name', 'hidden', 'position', 'content', 'driveFileId'].forEach(key => { if (req.body[key] !== undefined) file[key] = req.body[key]; });
  
  if (file.type === 'note' && (contentChanged || nameChanged)) {
    await syncNoteToDrive(req.user, file, meta);
  }

  await writeMeta(req.userId, meta);
  res.json(file);
});

app.put('/api/positions', requireAuth, async (req, res) => {
  const meta = await readMeta(req.userId);
  req.body.forEach(u => {
    const file = meta.files.find(f => f.id === u.id);
    if (file) file.position = u.position;
  });
  await writeMeta(req.userId, meta);
  res.json({ ok: true });
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const meta = await readMeta(req.userId);
  const file = meta.files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });

  if (file.driveFileId) await deleteFromDrive(file.driveFileId);
  if (file.driveThumbnailId) await deleteFromDrive(file.driveThumbnailId);

  if (file.type === 'folder') {
    const children = meta.files.filter(f => f.parentFolder === file.id);
    for (const c of children) {
      if (c.driveFileId) await deleteFromDrive(c.driveFileId);
      if (c.driveThumbnailId) await deleteFromDrive(c.driveThumbnailId);
    }
    meta.files = meta.files.filter(f => f.parentFolder !== file.id);
  }
  meta.files = meta.files.filter(f => f.id !== req.params.id);
  await writeMeta(req.userId, meta);
  res.json({ ok: true });
});

app.post('/api/folders', requireAuth, async (req, res) => {
  const meta = await readMeta(req.userId);
  const name = req.body.name || 'New Folder';
  let driveParentId = null;
  if (req.body.parentFolder) {
    const parentMeta = meta.files.find(f => f.id === req.body.parentFolder);
    if (parentMeta && parentMeta.driveFileId) driveParentId = parentMeta.driveFileId;
  }
  let driveFolderId = null;
  try { driveFolderId = await createDriveFolder(req.user, name, driveParentId); } catch (e) {}

  const folder = {
    id: uuidv4(), name, type: 'folder', size: 0, sizeFormatted: '—', uploadedAt: new Date().toISOString(),
    hidden: false, position: req.body.position || { x: 200, y: 200 }, parentFolder: req.body.parentFolder || null, groupId: req.body.groupId || 'default',
    driveFileId: driveFolderId
  };
  meta.files.push(folder);
  await writeMeta(req.userId, meta);
  res.json(folder);
});

app.post('/api/notes', requireAuth, async (req, res) => {
  const meta = await readMeta(req.userId);
  const note = {
    id: uuidv4(), name: req.body.name || 'New Note.txt', type: 'note', size: 0, sizeFormatted: '0 B', uploadedAt: new Date().toISOString(),
    hidden: false, position: req.body.position || { x: 200, y: 200 }, content: '', parentFolder: req.body.parentFolder || null, groupId: req.body.groupId || 'default'
  };
  await syncNoteToDrive(req.user, note, meta);
  meta.files.push(note);
  await writeMeta(req.userId, meta);
  res.json(note);
});

// ===== Startup =====
if (!LOCAL_UI_ONLY) {
  initAdminDrive();
  setTimeout(() => {
    ensureSpareFolder().catch((err) => console.error('  ✕ ensureSpareFolder startup:', err.message));
  }, 3000);
}
// Export app for Vercel
module.exports = app;

// Only listen if NOT on Vercel
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`
  🚀 Server is running!
  🏠 Local: http://localhost:${PORT}
  🔗 Base:  ${BASE_URL}
    `);
  });
}
