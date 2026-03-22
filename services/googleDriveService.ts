// src/services/googleDriveService.ts
// Upload PDF lên Google Drive qua Google Apps Script Web App
// ✅ Không cần Google Cloud Console, không cần OAuth popup

// ─── ⚙️ CẤU HÌNH — SỬA 2 DÒNG NÀY ────────────────────────────────────────────
const GAS_URL          = 'https://script.google.com/macros/s/AKfycbyWiyq9PTdxcfTy1Fljo1-yK0c-anRTo7uMBusJVUXKpUOeQilrKVzDvllyhkNsPOzD/exec';
const GAS_SECRET_TOKEN = 'taodepdf2026secret'; // phải khớp với CONFIG.secretToken trong Code.gs
// ───────────────────────────────────────────────────────────────────────────────

export interface DriveUploadResult {
  fileId:      string;
  viewUrl:     string;    // https://drive.google.com/file/d/{id}/view
  previewUrl:  string;    // https://drive.google.com/file/d/{id}/preview  ← dùng trong <iframe>
  downloadUrl: string;    // https://drive.google.com/uc?export=download&id={id}
  filename?:   string;
  sizeBytes?:  number;
}

// ─── Gọi GAS Web App ──────────────────────────────────────────────────────────
const callGAS = async (body: Record<string, any>): Promise<any> => {
  if (!GAS_URL || GAS_URL.includes('THAY_BANG')) {
    throw new Error(
      'Chưa cấu hình Google Apps Script!\n' +
      'Mở file googleDriveService.ts và điền GAS_URL + GAS_SECRET_TOKEN.',
    );
  }

  const res = await fetch(GAS_URL, {
    method:   'POST',
    headers:  { 'Content-Type': 'text/plain' },
    body:     JSON.stringify({ ...body, token: GAS_SECRET_TOKEN }),
    redirect: 'follow', // GAS redirect /exec → /echo, phải follow
  });

  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`GAS trả về lỗi ${res.status}: ${text}`);
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error('GAS không trả về JSON hợp lệ. Kiểm tra lại deployment.');
  }

  if (!json.success) {
    throw new Error(json.error || 'GAS báo lỗi không xác định');
  }

  return json;
};

// ─── Ping kiểm tra kết nối ────────────────────────────────────────────────────
export const pingGAS = async (): Promise<boolean> => {
  try {
    await callGAS({ action: 'ping' });
    return true;
  } catch {
    return false;
  }
};

// ─── Upload PDF lên Drive ─────────────────────────────────────────────────────
export const uploadPDFToGoogleDrive = async (
  pdfBase64: string,  // base64 không có header "data:application/pdf;base64,"
  filename:  string,  // tên file trên Drive
  folderId?: string,  // (tuỳ chọn) ID folder Drive cụ thể
): Promise<DriveUploadResult> => {
  console.log(`📤 Uploading "${filename}" to Drive via GAS...`);

  const result = await callGAS({
    action: 'upload',
    filename,
    base64: pdfBase64,
    ...(folderId && { folderId }),
  });

  console.log(`✅ Uploaded: ${result.fileId} (${result.sizeBytes ? Math.round(result.sizeBytes / 1024) + ' KB' : '?'})`);

  return {
    fileId:      result.fileId,
    viewUrl:     result.viewUrl,
    previewUrl:  result.previewUrl,
    downloadUrl: result.downloadUrl,
    filename:    result.filename,
    sizeBytes:   result.sizeBytes,
  };
};

// ─── Xoá file Drive ───────────────────────────────────────────────────────────
export const deletePDFFromDrive = async (fileId: string): Promise<void> => {
  try {
    await callGAS({ action: 'delete', fileId });
    console.log(`🗑️ Deleted Drive file: ${fileId}`);
  } catch (err) {
    console.warn('deletePDFFromDrive (ignored):', err);
  }
};
