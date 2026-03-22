// src/components/PDFExamCreator.tsx
// Wizard tạo đề thi từ file PDF
// ✅ CẢI TIẾN: Upload PDF lên Google Drive qua GAS (không cần OAuth popup)

import React, { useState, useRef, useCallback } from 'react';
import { Exam, Question, ExamSection, ExamPointsConfig, SectionPointsConfig } from '../types';
import PointsConfigEditor from './PointsConfigEditor';
import { uploadPDFToGoogleDrive, DriveUploadResult } from '../services/googleDriveService';

// ─── Types nội bộ ────────────────────────────────────────────────────────────

interface PDFExamConfig {
  title: string;
  timeLimit: number;
  mcCount: number;
  tfCount: number;
  saCount: number;
}

type MCAnswers = { [qNum: number]: string };
type TFAnswers = { [qNum: number]: string[] };
type SAAnswers = { [qNum: number]: string };

interface PDFExamCreatorProps {
  teacherId: string;
  teacherName: string;
  onSave: (exam: Omit<Exam, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  onCancel: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function mcRange(n: number)  { return Array.from({ length: n }, (_, i) => i + 1); }
function tfRange(n: number)  { return Array.from({ length: n }, (_, i) => 201 + i); }
function saRange(n: number)  { return Array.from({ length: n }, (_, i) => 301 + i); }

function buildDefaultPointsConfig(mc: number, tf: number, sa: number): ExamPointsConfig {
  const sections: SectionPointsConfig[] = [];
  if (mc > 0) sections.push({ sectionId: 'part1', sectionName: 'PHẦN I. TRẮC NGHIỆM NHIỀU LỰA CHỌN', questionType: 'multiple_choice', totalQuestions: mc, totalPoints: 3, pointsPerQuestion: parseFloat((3 / mc).toFixed(4)) });
  if (tf > 0) sections.push({ sectionId: 'part2', sectionName: 'PHẦN II. TRẮC NGHIỆM ĐÚNG SAI',       questionType: 'true_false',       totalQuestions: tf, totalPoints: 4, pointsPerQuestion: parseFloat((4 / tf).toFixed(4)), trueFalseMode: 'stepped' });
  if (sa > 0) sections.push({ sectionId: 'part3', sectionName: 'PHẦN III. TRẢ LỜI NGẮN',              questionType: 'short_answer',      totalQuestions: sa, totalPoints: 3, pointsPerQuestion: parseFloat((3 / sa).toFixed(4)) });
  return { maxScore: 10, sections, autoBalance: false };
}

function buildExamData(config: PDFExamConfig, mcAns: MCAnswers, tfAns: TFAnswers, saAns: SAAnswers) {
  const questions: Question[] = [];
  const answers: { [k: number]: string } = {};

  mcRange(config.mcCount).forEach(n => {
    const ans = mcAns[n] || '';
    questions.push({ number: n, text: `Câu ${n}`, type: 'multiple_choice', options: ['A','B','C','D'].map(l => ({ letter: l, text: l })), correctAnswer: ans || null, part: 'PHẦN I' });
    if (ans) answers[n] = ans;
  });
  tfRange(config.tfCount).forEach((n, idx) => {
    const cells = tfAns[n] || ['','','',''];
    const tfMap: Record<string, boolean> = {};
    ['a','b','c','d'].forEach((lbl, i) => { tfMap[lbl] = cells[i] === 'Đ'; });
    const hasAnswer = cells.some(c => c === 'Đ' || c === 'S');
    questions.push({ number: n, text: `Câu ${idx + 1}`, type: 'true_false', options: [], correctAnswer: hasAnswer ? JSON.stringify(tfMap) : null, part: 'PHẦN II' });
    if (hasAnswer) answers[n] = JSON.stringify(tfMap);
  });
  saRange(config.saCount).forEach((n, idx) => {
    const ans = saAns[n] || '';
    questions.push({ number: n, text: `Câu ${idx + 1}`, type: 'short_answer', options: [], correctAnswer: ans || null, part: 'PHẦN III' });
    if (ans) answers[n] = ans;
  });

  const sections: ExamSection[] = [];
  if (config.mcCount > 0) sections.push({ name: 'PHẦN I. TRẮC NGHIỆM NHIỀU LỰA CHỌN', description: `Thí sinh trả lời từ câu 1 đến câu ${config.mcCount}.`, points: '3', questions: questions.filter(q => q.part === 'PHẦN I'),  sectionType: 'multiple_choice' });
  if (config.tfCount > 0) sections.push({ name: 'PHẦN II. TRẮC NGHIỆM ĐÚNG SAI',       description: `Thí sinh trả lời từ câu 1 đến câu ${config.tfCount}.`, points: '4', questions: questions.filter(q => q.part === 'PHẦN II'), sectionType: 'true_false' });
  if (config.saCount > 0) sections.push({ name: 'PHẦN III. TRẢ LỜI NGẮN',              description: `Thí sinh trả lời từ câu 1 đến câu ${config.saCount}.`, points: '3', questions: questions.filter(q => q.part === 'PHẦN III'), sectionType: 'short_answer' });
  return { questions, sections, answers };
}

// ─── Step Indicator ───────────────────────────────────────────────────────────
function StepIndicator({ step }: { step: number }) {
  const labels = ['1.PDF', '2.Cấu hình', '3.Đáp án', '4.Điểm & Lưu'];
  return (
    <div className="flex items-center gap-1 mb-6">
      {labels.map((label, i) => {
        const s = i + 1;
        const active = step === s, done = step > s;
        return (
          <React.Fragment key={s}>
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition
              ${active ? 'bg-teal-600 text-white' : done ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-400'}`}>
              <span>{done ? '✓' : s}</span>
              <span className="hidden sm:inline">{label}</span>
            </div>
            {i < 3 && <div className="flex-1 h-0.5 bg-gray-200 mx-1 rounded" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Upload Drive Button ──────────────────────────────────────────────────────
type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

interface DriveUploadBlockProps {
  pdfBase64:   string;
  pdfFileName: string;
  pdfSizeKB:   number;
  examTitle:   string;
  result:      DriveUploadResult | null;
  status:      UploadStatus;
  error:       string;
  onUpload:    () => void;
  onReset:     () => void;
}

function DriveUploadBlock({
  pdfBase64, pdfFileName, pdfSizeKB, examTitle,
  result, status, error, onUpload, onReset,
}: DriveUploadBlockProps) {
  const borderCls = result
    ? 'border-green-300 bg-green-50'
    : status === 'error'
      ? 'border-red-300 bg-red-50'
      : 'border-blue-200 bg-blue-50';

  return (
    <div className={`rounded-xl border-2 p-4 mb-4 transition ${borderCls}`}>
      <div className="flex items-start gap-3">
        <span className="text-2xl mt-0.5">
          {result ? '✅' : status === 'error' ? '❌' : status === 'uploading' ? '⏫' : '📂'}
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-gray-800">
            {result ? 'PDF đã lưu trên Google Drive' : 'Lưu PDF lên Google Drive'}
          </p>

          {/* DONE */}
          {result && (
            <>
              <p className="text-xs text-green-700 mt-1">
                📁 Folder: <em>ĐềThiPDF</em> trên Drive của quản trị script
              </p>
              <p className="text-xs text-gray-500 mt-0.5 truncate">
                🔗 <a href={result.viewUrl} target="_blank" rel="noopener noreferrer"
                      className="underline hover:text-blue-700">{result.viewUrl}</a>
              </p>
              {result.sizeBytes && (
                <p className="text-xs text-gray-400">{Math.round(result.sizeBytes / 1024)} KB</p>
              )}
              <button onClick={onReset}
                className="mt-2 text-xs text-gray-400 underline hover:text-gray-600">
                Upload lại file khác
              </button>
            </>
          )}

          {/* UPLOADING */}
          {status === 'uploading' && !result && (
            <p className="text-xs text-blue-700 mt-1 animate-pulse">
              ⏳ Đang upload <strong>{pdfFileName}</strong> ({pdfSizeKB} KB)...
            </p>
          )}

          {/* ERROR */}
          {status === 'error' && (
            <>
              <p className="text-xs text-red-700 mt-1 whitespace-pre-wrap break-words">{error}</p>
              <button onClick={onUpload}
                className="mt-2 px-3 py-1 bg-red-600 text-white rounded-lg text-xs font-semibold hover:bg-red-700">
                Thử lại
              </button>
            </>
          )}

          {/* IDLE */}
          {status === 'idle' && !result && (
            <>
              <p className="text-xs text-gray-500 mt-1">
                PDF sẽ được lưu vào folder <strong>"ĐềThiPDF"</strong> trên Drive và đặt quyền công khai (anyone with link).
              </p>
              <button
                onClick={onUpload}
                disabled={!pdfBase64}
                className="mt-2 px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-semibold
                  hover:bg-blue-700 disabled:opacity-40 flex items-center gap-2">
                {/* Google Drive icon mini */}
                <svg className="w-4 h-4" viewBox="0 0 87.3 78" fill="white" xmlns="http://www.w3.org/2000/svg">
                  <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H14.25c0 3.15-.85 6.05-2.35 8.55L6.6 66.85z"/>
                  <path d="M43.65 25L29.9 1.2C28.55 1.2 27.2 1.55 26 2.35c-1.2.8-2.1 1.9-2.75 3.2L.5 44.4h19.2L43.65 25z"/>
                  <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.75-1.3 1.15-2.75 1.15-4.25H67.5l4.05 7 2 3.25 0 0z"/>
                  <path d="M43.65 25l23.85 19.4h19.2L64.15 5.55C63.5 4.25 62.6 3.15 61.4 2.35 60.2 1.55 58.85 1.2 57.5 1.2L43.65 25z"/>
                  <path d="M27.5 53.2L13.75 77c1.35.8 2.85 1.2 4.4 1.2h49.3c1.55 0 3.05-.4 4.4-1.2L57.5 53.2H27.5z"/>
                  <path d="M67.5 53.2H27.5l-13.75 0H0.5c0 1.5.4 2.95 1.15 4.25L14.25 53.2h13.25v0H57.5l9.95 0z"/>
                </svg>
                Upload lên Google Drive
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── COMPONENT CHÍNH ─────────────────────────────────────────────────────────

const PDFExamCreator: React.FC<PDFExamCreatorProps> = ({ teacherId, teacherName, onSave, onCancel }) => {
  const [step, setStep] = useState<1|2|3|4>(1);
  const [isSaving, setIsSaving] = useState(false);

  // Step 1
  const [pdfBase64, setPdfBase64]     = useState('');
  const [pdfFileName, setPdfFileName] = useState('');
  const [pdfSizeKB, setPdfSizeKB]     = useState(0);
  const [config, setConfig] = useState<PDFExamConfig>({ title: '', timeLimit: 90, mcCount: 12, tfCount: 4, saCount: 6 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 3
  const [mcAnswers, setMcAnswers] = useState<MCAnswers>({});
  const [tfAnswers, setTfAnswers] = useState<TFAnswers>({});
  const [saAnswers, setSaAnswers] = useState<SAAnswers>({});

  // Step 4
  const [pointsConfig, setPointsConfig] = useState<ExamPointsConfig | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadError, setUploadError]   = useState('');
  const [driveResult, setDriveResult]   = useState<DriveUploadResult | null>(null);

  // ─── File handling ──────────────────────────────────────────
  const handleFileUpload = useCallback((file: File) => {
    if (!file || file.type !== 'application/pdf') { alert('Vui lòng chọn file PDF hợp lệ.'); return; }
    if (file.size > 50 * 1024 * 1024) { alert('File PDF quá lớn (tối đa 50 MB).'); return; }
    setDriveResult(null); setUploadStatus('idle'); setUploadError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setPdfBase64(result.split(',')[1]);
      setPdfFileName(file.name);
      setPdfSizeKB(Math.round(file.size / 1024));
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }, [handleFileUpload]);

  // ─── Upload to Drive via GAS ────────────────────────────────
  const handleUploadToDrive = async () => {
    if (!pdfBase64) return;
    setUploadStatus('uploading');
    setUploadError('');
    try {
      const filename = pdfFileName || `${config.title.trim() || 'dethi'}.pdf`;
      const result   = await uploadPDFToGoogleDrive(pdfBase64, filename);
      setDriveResult(result);
      setUploadStatus('done');
    } catch (err: any) {
      setUploadStatus('error');
      setUploadError(err?.message || 'Lỗi không xác định khi upload.');
      console.error('Drive upload error:', err);
    }
  };

  // ─── Save exam ──────────────────────────────────────────────
  const handleSave = async () => {
    if (!pointsConfig || !driveResult) return;
    setIsSaving(true);
    try {
      const { questions, sections, answers } = buildExamData(config, mcAnswers, tfAnswers, saAnswers);
      await onSave({
        title:       config.title.trim(),
        timeLimit:   config.timeLimit,
        questions, sections, answers,
        createdBy:   teacherId,
        pointsConfig,
        pdfDriveUrl:    driveResult.viewUrl,
        pdfDriveFileId: driveResult.fileId,
      } as any);
    } catch (err) {
      console.error(err);
      alert('Có lỗi khi lưu đề. Vui lòng thử lại.');
    } finally {
      setIsSaving(false);
    }
  };

  const step1Valid = !!(pdfBase64 && config.title.trim() && config.timeLimit > 0
    && (config.mcCount + config.tfCount + config.saCount) > 0);

  const enterStep4 = () => {
    if (!pointsConfig) setPointsConfig(buildDefaultPointsConfig(config.mcCount, config.tfCount, config.saCount));
    setStep(4);
  };

  // ─── BƯỚC 1 ─────────────────────────────────────────────────
  if (step === 1) return (
    <div className="max-w-3xl mx-auto p-6 bg-white rounded-2xl shadow-lg">
      <StepIndicator step={step} />
      <h2 className="text-xl font-bold text-gray-800 mb-1">📄 Tải đề thi PDF</h2>
      <p className="text-sm text-gray-500 mb-5">
        Upload file PDF — sẽ được lưu lên <strong>Google Drive</strong> (không tốn Firestore storage)
      </p>

      <div onDrop={handleDrop} onDragOver={e => e.preventDefault()}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition
          ${pdfBase64 ? 'border-teal-400 bg-teal-50' : 'border-gray-300 bg-gray-50 hover:border-teal-400 hover:bg-teal-50'}`}>
        <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); }} />
        {pdfBase64 ? (
          <><p className="text-3xl mb-2">✅</p><p className="font-semibold text-teal-700">{pdfFileName}</p>
          <p className="text-sm text-teal-600">{pdfSizeKB} KB — nhấn để đổi file</p></>
        ) : (
          <><p className="text-5xl mb-3">📄</p><p className="font-semibold text-gray-600">Kéo thả hoặc nhấn để chọn PDF</p>
          <p className="text-sm text-gray-400 mt-1">Tối đa 50 MB</p></>
        )}
      </div>

      {pdfBase64 && (
        <div className="mt-5 space-y-3">
          <div>
            <label className="text-sm font-medium text-gray-700">Tiêu đề đề thi *</label>
            <input type="text" placeholder="VD: Kiểm tra Toán 10 HK1 2024-2025"
              value={config.title} onChange={e => setConfig(c => ({ ...c, title: e.target.value }))}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Thời gian (phút) *</label>
            <input type="number" min={5} max={300} value={config.timeLimit}
              onChange={e => setConfig(c => ({ ...c, timeLimit: Number(e.target.value) }))}
              className="mt-1 w-40 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>
        </div>
      )}

      <div className="flex justify-between mt-6">
        <button onClick={onCancel} className="px-5 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">Hủy</button>
        <button disabled={!step1Valid} onClick={() => setStep(2)}
          className="px-6 py-2 bg-teal-600 text-white rounded-lg font-semibold disabled:opacity-40 hover:bg-teal-700">Tiếp theo →</button>
      </div>
    </div>
  );

  // ─── BƯỚC 2 ─────────────────────────────────────────────────
  if (step === 2) return (
    <div className="max-w-3xl mx-auto p-6 bg-white rounded-2xl shadow-lg">
      <StepIndicator step={step} />
      <h2 className="text-xl font-bold text-gray-800 mb-1">⚙️ Cấu hình số câu</h2>
      <p className="text-sm text-gray-500 mb-5">Nhập số lượng câu từng phần</p>
      <div className="space-y-3">
        <SectionRow icon="🔘" color="blue"   title="PHẦN I – Trắc nghiệm nhiều lựa chọn" desc="Câu 1 → N (đáp án A/B/C/D)"        rangeLabel={`Câu 1–${config.mcCount}`}           value={config.mcCount} onChange={v => setConfig(c => ({...c, mcCount: v}))} />
        <SectionRow icon="☑️" color="purple" title="PHẦN II – Trắc nghiệm đúng/sai"      desc="Mỗi câu có 4 ý a b c d (Đ/S)"     rangeLabel={`Câu 201–${200 + config.tfCount}`}   value={config.tfCount} onChange={v => setConfig(c => ({...c, tfCount: v}))} />
        <SectionRow icon="✍️" color="orange" title="PHẦN III – Trả lời ngắn"             desc="Nhập kết quả dạng số hoặc chữ"     rangeLabel={`Câu 301–${300 + config.saCount}`}   value={config.saCount} onChange={v => setConfig(c => ({...c, saCount: v}))} />
      </div>
      <div className="flex justify-between mt-6">
        <button onClick={() => setStep(1)} className="px-5 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">← Quay lại</button>
        <button disabled={(config.mcCount + config.tfCount + config.saCount) === 0} onClick={() => setStep(3)}
          className="px-6 py-2 bg-teal-600 text-white rounded-lg font-semibold disabled:opacity-40 hover:bg-teal-700">Tiếp theo →</button>
      </div>
    </div>
  );

  // ─── BƯỚC 3 ─────────────────────────────────────────────────
  if (step === 3) {
    const mcNums = mcRange(config.mcCount), tfNums = tfRange(config.tfCount), saNums = saRange(config.saCount);
    const answeredMC = Object.values(mcAnswers).filter(Boolean).length;
    const answeredSA = Object.values(saAnswers).filter(Boolean).length;
    const answeredTF = Object.values(tfAnswers).filter(v => v.filter(Boolean).length === 4).length;
    return (
      <div className="max-w-3xl mx-auto p-6 bg-white rounded-2xl shadow-lg">
        <StepIndicator step={step} />
        <h2 className="text-xl font-bold text-gray-800 mb-1">🔑 Nhập đáp án</h2>
        <p className="text-sm text-gray-500 mb-5">Nhập đáp án đúng cho từng câu</p>

        {mcNums.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold text-blue-700 mb-3">🔘 PHẦN I — Trắc nghiệm ({answeredMC}/{mcNums.length})</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {mcNums.map(n => (
                <div key={n} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                  <span className="text-xs font-semibold text-gray-500 w-10 shrink-0">Câu {n}</span>
                  <div className="flex gap-1">
                    {['A','B','C','D'].map(l => (
                      <button key={l} onClick={() => setMcAnswers(p => ({ ...p, [n]: p[n] === l ? '' : l }))}
                        className={`w-7 h-7 rounded-full text-xs font-bold transition
                          ${mcAnswers[n] === l
                            ? ({ A: 'bg-pink-500', B: 'bg-sky-500', C: 'bg-green-500', D: 'bg-orange-500' } as any)[l] + ' text-white'
                            : 'bg-white border border-gray-300 text-gray-500 hover:bg-gray-100'}`}>{l}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tfNums.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold text-purple-700 mb-3">☑️ PHẦN II — Đúng/Sai ({answeredTF}/{tfNums.length})</h3>
            <div className="space-y-3">
              {tfNums.map((n, idx) => {
                const cells = tfAnswers[n] || ['','','',''];
                return (
                  <div key={n} className="bg-purple-50 border border-purple-100 rounded-xl p-3">
                    <p className="text-xs font-bold text-purple-800 mb-2">Câu {idx + 1}</p>
                    <div className="grid grid-cols-4 gap-2">
                      {['a','b','c','d'].map((lbl, i) => (
                        <div key={lbl} className="flex flex-col items-center gap-1">
                          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white
                            ${['bg-pink-500','bg-sky-500','bg-green-500','bg-orange-500'][i]}`}>{lbl.toUpperCase()}</span>
                          <div className="flex gap-1">
                            {['Đ','S'].map(v => (
                              <button key={v} onClick={() => setTfAnswers(p => {
                                  const cur = p[n] || ['','','','']; const next = [...cur]; next[i] = next[i] === v ? '' : v; return {...p,[n]:next};
                                })}
                                className={`px-2 py-0.5 rounded text-xs font-bold transition
                                  ${cells[i] === v ? v === 'Đ' ? 'bg-green-500 text-white' : 'bg-red-500 text-white' : 'bg-white border border-gray-300 text-gray-500 hover:bg-gray-100'}`}>{v}</button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {saNums.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold text-orange-700 mb-3">✍️ PHẦN III — Trả lời ngắn ({answeredSA}/{saNums.length})</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {saNums.map((n, idx) => (
                <div key={n} className="flex items-center gap-2 bg-orange-50 rounded-lg px-3 py-2">
                  <span className="text-xs font-semibold text-gray-500 w-12 shrink-0">Câu {idx+1}</span>
                  <input type="text" placeholder="Đáp án" value={saAnswers[n] || ''} onChange={e => setSaAnswers(p => ({...p,[n]:e.target.value}))}
                    className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400" />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-between mt-6">
          <button onClick={() => setStep(2)} className="px-5 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">← Quay lại</button>
          <button onClick={enterStep4} className="px-6 py-2 bg-teal-600 text-white rounded-lg font-semibold hover:bg-teal-700">Tiếp theo →</button>
        </div>
      </div>
    );
  }

  // ─── BƯỚC 4 ─────────────────────────────────────────────────
  if (step === 4) {
    const answeredCount = Object.keys({...mcAnswers, ...saAnswers}).length
      + Object.values(tfAnswers).filter(v => v.filter(Boolean).length === 4).length;
    const totalQ = config.mcCount + config.tfCount + config.saCount;
    return (
      <div className="max-w-3xl mx-auto p-6 bg-white rounded-2xl shadow-lg">
        <StepIndicator step={step} />
        <h2 className="text-xl font-bold text-gray-800 mb-1">⚖️ Điểm & Lưu đề</h2>
        <p className="text-sm text-gray-500 mb-5">Upload PDF lên Drive, cấu hình điểm, rồi lưu</p>

        {/* Tóm tắt */}
        <div className="bg-teal-50 border border-teal-200 rounded-lg p-4 mb-4 text-sm">
          <p className="font-semibold text-teal-800 mb-1">📋 {config.title}</p>
          <div className="flex gap-4 text-teal-700 flex-wrap text-xs">
            {config.mcCount > 0 && <span>🔘 {config.mcCount} TN</span>}
            {config.tfCount > 0 && <span>☑️ {config.tfCount} Đ/S</span>}
            {config.saCount > 0 && <span>✍️ {config.saCount} TLN</span>}
            <span>⏱ {config.timeLimit} phút</span>
            <span className={answeredCount < totalQ ? 'text-orange-600' : 'text-green-700'}>
              🔑 {answeredCount}/{totalQ} đáp án
            </span>
          </div>
        </div>

        {/* Upload Drive block */}
        <DriveUploadBlock
          pdfBase64={pdfBase64} pdfFileName={pdfFileName} pdfSizeKB={pdfSizeKB}
          examTitle={config.title}
          result={driveResult} status={uploadStatus} error={uploadError}
          onUpload={handleUploadToDrive}
          onReset={() => { setDriveResult(null); setUploadStatus('idle'); setUploadError(''); }}
        />

        {/* Thang điểm */}
        {pointsConfig && (
          <PointsConfigEditor config={pointsConfig} onChange={setPointsConfig}
            onClose={() => {}} closeOnSave={false} isSaving={isSaving} />
        )}

        <div className="flex justify-between mt-6">
          <button onClick={() => setStep(3)} className="px-5 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">← Quay lại</button>
          <button onClick={handleSave} disabled={isSaving || !pointsConfig || !driveResult}
            className="px-8 py-2 bg-teal-600 text-white rounded-lg font-semibold disabled:opacity-40 hover:bg-teal-700 flex items-center gap-2">
            {isSaving && <span className="animate-spin">⏳</span>}
            {isSaving ? 'Đang lưu...' : !driveResult ? '☁️ Upload Drive trước' : '💾 Lưu đề thi'}
          </button>
        </div>
      </div>
    );
  }

  return null;
};

// ─── SectionRow sub-component ────────────────────────────────────────────────
interface SectionRowProps { icon: string; color: 'blue'|'purple'|'orange'; title: string; desc: string; value: number; onChange: (v: number) => void; rangeLabel: string; }
function SectionRow({ icon, color, title, desc, value, onChange, rangeLabel }: SectionRowProps) {
  const borderCls = { blue: 'border-blue-200 bg-blue-50', purple: 'border-purple-200 bg-purple-50', orange: 'border-orange-200 bg-orange-50' }[color];
  const textCls   = { blue: 'text-blue-800', purple: 'text-purple-800', orange: 'text-orange-800' }[color];
  return (
    <div className={`border rounded-xl p-4 ${borderCls}`}>
      <div className="flex items-start gap-3">
        <span className="text-2xl">{icon}</span>
        <div className="flex-1 min-w-0">
          <p className={`font-semibold text-sm ${textCls}`}>{title}</p>
          <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
          <p className="text-xs text-gray-400 mt-1">📌 {rangeLabel}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => onChange(Math.max(0, value - 1))} className="w-7 h-7 rounded-full bg-white border border-gray-300 text-gray-600 font-bold hover:bg-gray-100">−</button>
          <input type="number" min={0} max={40} value={value} onChange={e => onChange(Math.max(0, Number(e.target.value)))}
            className="w-14 text-center border border-gray-300 rounded-lg py-1 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          <button onClick={() => onChange(value + 1)} className="w-7 h-7 rounded-full bg-white border border-gray-300 text-gray-600 font-bold hover:bg-gray-100">+</button>
        </div>
      </div>
    </div>
  );
}

export default PDFExamCreator;
