// ============================================================
// Google Apps Script — PDF Upload Proxy
// Dán code này vào: https://script.google.com → New Project
//
// Deploy: Extensions → Apps Script → Deploy → New deployment
//   Type            : Web app
//   Execute as      : Me  (chạy dưới account của bạn)
//   Who has access  : Anyone  (không cần đăng nhập)
// ============================================================

// ─── CẤU HÌNH ────────────────────────────────────────────────
const CONFIG = {
  folderName : 'ĐềThiPDF',    // Tên folder tự động tạo trên Drive
  secretToken: 'THAY_BANG_MAT_KHAU_BI_MAT',  // ← đổi thành chuỗi bí mật bất kỳ
                               //   ví dụ: 'taodepdf2024_secret'
                               //   Phải khớp với GAS_SECRET_TOKEN trong React app
};

// ─── CORS PRE-FLIGHT ──────────────────────────────────────────
// GAS không hỗ trợ set header trực tiếp, nhưng doGet/doPost
// tự động có CORS khi deploy "Anyone". Nếu gặp lỗi OPTIONS,
// thêm doGet để trả về response rỗng cho preflight.
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: 'PDF Drive Proxy' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
function doPost(e) {
  try {
    // Parse body
    let data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (_) {
      return errorResponse('Invalid JSON body');
    }

    // ─── Xác thực token bí mật ─────────────────────────────
    if (data.token !== CONFIG.secretToken) {
      return errorResponse('Unauthorized — token không hợp lệ', 401);
    }

    const action = data.action || 'upload';

    if (action === 'upload')  return handleUpload(data);
    if (action === 'delete')  return handleDelete(data);
    if (action === 'ping')    return okResponse({ pong: true });

    return errorResponse('Unknown action: ' + action);

  } catch (err) {
    console.error('doPost error:', err);
    return errorResponse(err.message || 'Internal error');
  }
}

// ─── UPLOAD ───────────────────────────────────────────────────
function handleUpload(data) {
  const { filename, base64, folderId } = data;

  if (!base64 || base64.length === 0) {
    return errorResponse('base64 is empty');
  }

  // Decode base64 → Blob
  const bytes = Utilities.base64Decode(base64);
  const blob  = Utilities.newBlob(bytes, 'application/pdf', filename || 'dethi.pdf');

  // Lấy hoặc tạo folder
  let file;
  if (folderId) {
    // Nếu caller chỉ định folder cụ thể
    try {
      file = DriveApp.getFolderById(folderId).createFile(blob);
    } catch (_) {
      // Folder không tồn tại hoặc không có quyền → dùng folder mặc định
      file = getDefaultFolder().createFile(blob);
    }
  } else {
    file = getDefaultFolder().createFile(blob);
  }

  // Set quyền: ai có link đều xem được (không cần đăng nhập Drive)
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const fileId = file.getId();
  console.log('Uploaded PDF:', filename, '→ fileId:', fileId);

  return okResponse({
    fileId,
    viewUrl    : `https://drive.google.com/file/d/${fileId}/view`,
    previewUrl : `https://drive.google.com/file/d/${fileId}/preview`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
    filename   : file.getName(),
    sizeBytes  : file.getSize(),
  });
}

// ─── DELETE ───────────────────────────────────────────────────
function handleDelete(data) {
  const { fileId } = data;
  if (!fileId) return errorResponse('fileId is required');

  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    console.log('Deleted (trashed) file:', fileId);
    return okResponse({ deleted: fileId });
  } catch (err) {
    // File không tồn tại hoặc không có quyền — bỏ qua
    console.warn('Delete failed (ignored):', err.message);
    return okResponse({ deleted: fileId, warning: err.message });
  }
}

// ─── HELPERS ──────────────────────────────────────────────────
function getDefaultFolder() {
  const iter = DriveApp.getFoldersByName(CONFIG.folderName);
  if (iter.hasNext()) return iter.next();
  // Tạo mới nếu chưa có
  const folder = DriveApp.createFolder(CONFIG.folderName);
  console.log('Created folder:', CONFIG.folderName);
  return folder;
}

function okResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, ...data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(msg, code) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: msg, code: code || 400 }))
    .setMimeType(ContentService.MimeType.JSON);
}
