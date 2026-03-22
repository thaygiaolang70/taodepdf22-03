// src/components/PDFExamRoom.tsx
// Phòng thi dạng PDF: bên trái = PDF (iframe Drive hoặc base64), bên phải = ô trả lời
// ✅ CẢI TIẾN: Ưu tiên Google Drive iframe; hiển thị link PDF sau khi nộp bài

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Room, Exam, StudentInfo, Submission, ScoreBreakdown } from '../types';
import {
  ensureSignedIn,
  createSubmission,
  submitExam,
  subscribeToRoom,
} from '../services/firebaseService';
import { getTabDetectionService } from '../services/tabDetectionService';

// ─── Types ────────────────────────────────────────────────────────────────────

type MCAnswers = { [n: number]: string };
type TFAnswers = { [n: number]: string[] };
type SAAnswers = { [n: number]: string };

function mergeAnswers(mc: MCAnswers, tf: TFAnswers, sa: SAAnswers): { [n: number]: string } {
  const all: { [n: number]: string } = {};
  Object.entries(mc).forEach(([k, v]) => { if (v) all[Number(k)] = v; });
  Object.entries(tf).forEach(([k, v]) => {
    const hasAny = (v || []).some(x => x === 'Đ' || x === 'S');
    if (hasAny) {
      const obj: Record<string, boolean> = {};
      ['a', 'b', 'c', 'd'].forEach((lbl, i) => { obj[lbl] = v[i] === 'Đ'; });
      all[Number(k)] = JSON.stringify(obj);
    }
  });
  Object.entries(sa).forEach(([k, v]) => { if (v?.trim()) all[Number(k)] = v.trim(); });
  return all;
}

function formatTimer(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function optionBg(letter: string, selected: boolean) {
  if (!selected) return 'bg-gray-100 text-gray-700 hover:bg-gray-200';
  const map: Record<string, string> = {
    A: 'bg-pink-500 text-white',
    B: 'bg-sky-500 text-white',
    C: 'bg-green-500 text-white',
    D: 'bg-orange-500 text-white',
  };
  return map[letter] || 'bg-gray-400 text-white';
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface PDFExamRoomProps {
  room: Room;
  exam: Exam;
  student: StudentInfo;
  existingSubmissionId?: string;
  onSubmitted: (submission: Submission) => void;
  onExit: () => void;
}

// ─── Draggable Divider Hook (horizontal — trái/phải) ─────────────────────────

function useHorizontalSplit(defaultPercent = 62) {
  const [splitPct, setSplitPct] = useState(defaultPercent);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const clamp = (v: number) => Math.min(80, Math.max(30, v));

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplitPct(clamp(pct));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const snapTo = useCallback((pct: number) => setSplitPct(clamp(pct)), []);

  const dragHandleProps = { onPointerDown, onPointerMove, onPointerUp };

  return { splitPct, dragHandleProps, containerRef, snapTo };
}

// ─── Component ────────────────────────────────────────────────────────────────

const PDFExamRoom: React.FC<PDFExamRoomProps> = ({
  room, exam, student, existingSubmissionId, onSubmitted, onExit,
}) => {
  const mcQuestions = exam.questions.filter(q => q.type === 'multiple_choice');
  const tfQuestions = exam.questions.filter(q => q.type === 'true_false');
  const saQuestions = exam.questions.filter(q => q.type === 'short_answer');

  const [mcAnswers, setMcAnswers] = useState<MCAnswers>({});
  const [tfAnswers, setTfAnswers] = useState<TFAnswers>({});
  const [saAnswers, setSaAnswers] = useState<SAAnswers>({});

  const [submissionId, setSubmissionId] = useState<string | undefined>(existingSubmissionId);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [tabWarnings, setTabWarnings] = useState<Date[]>([]);
  const [showTabWarning, setShowTabWarning] = useState(false);

  const [timeLeft, setTimeLeft] = useState(room.timeLimit * 60);
  const timerRed = timeLeft <= 5 * 60;

  const { splitPct, dragHandleProps, containerRef, snapTo } = useHorizontalSplit(62);

  // ✅ Xác định nguồn PDF: ưu tiên Drive URL, fallback base64
  const drivePdfUrl   = (exam as any).pdfDriveUrl as string | undefined;
  const driveFileId   = (exam as any).pdfDriveFileId as string | undefined;
  const pdfBase64     = (exam as any).pdfBase64 as string | undefined;

  // iframe Drive preview URL: luôn hoạt động, không cần token
  const drivePreviewUrl = driveFileId
    ? `https://drive.google.com/file/d/${driveFileId}/preview`
    : drivePdfUrl?.replace('/view', '/preview');

  const totalQ      = mcQuestions.length + tfQuestions.length + saQuestions.length;
  const answeredMC  = Object.values(mcAnswers).filter(Boolean).length;
  const answeredTF  = Object.values(tfAnswers).filter(v => (v||[]).some(x => x==='Đ'||x==='S')).length;
  const answeredSA  = Object.values(saAnswers).filter(v => v?.trim()).length;
  const totalAnswered = answeredMC + answeredTF + answeredSA;
  const progress    = totalQ > 0 ? Math.round((totalAnswered / totalQ) * 100) : 0;

  // ─── Tạo submission ───────────────────────────────────────────────────────
  useEffect(() => {
    if (existingSubmissionId) return;
    const init = async () => {
      await ensureSignedIn();
      const id = await createSubmission({
        roomId:    room.id,
        roomCode:  room.code,
        examId:    exam.id,
        student,
        answers:   {},
        scoreBreakdown: {
          multipleChoice: { total: 0, correct: 0, points: 0 },
          trueFalse:      { total: 0, correct: 0, partial: 0, points: 0, details: {} },
          shortAnswer:    { total: 0, correct: 0, points: 0 },
          totalScore: 0, percentage: 0,
        },
        totalScore: 0, percentage: 0,
        score: 0, correctCount: 0, wrongCount: 0, totalQuestions: totalQ,
        tabSwitchCount: 0, tabSwitchWarnings: [], autoSubmitted: false,
        duration: 0, status: 'in_progress',
      });
      setSubmissionId(id);
    };
    init().catch(console.error);
  }, []);

  // ─── Timer ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isSubmitted) return;
    const t = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) { clearInterval(t); handleAutoSubmit(); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [isSubmitted]);

  // ─── Tab detection ────────────────────────────────────────────────────────
  useEffect(() => {
    const svc = getTabDetectionService();
    svc.start({
      onTabSwitch: (count, warnings) => {
        setTabSwitchCount(count);
        setTabWarnings(warnings);
        setShowTabWarning(true);
        setTimeout(() => setShowTabWarning(false), 4000);
      },
      onAutoSubmit: () => handleAutoSubmit(),
    });
    return () => svc.stop();
  }, []);

  // ─── Answer handlers ──────────────────────────────────────────────────────
  const setMC = (qNum: number, letter: string) =>
    setMcAnswers(p => ({ ...p, [qNum]: p[qNum] === letter ? '' : letter }));

  const setTF = (qNum: number, idx: number, val: string) =>
    setTfAnswers(p => {
      const cur = p[qNum] || ['', '', '', ''];
      const next = [...cur]; next[idx] = next[idx] === val ? '' : val;
      return { ...p, [qNum]: next };
    });

  const setSA = (qNum: number, val: string) =>
    setSaAnswers(p => ({ ...p, [qNum]: val }));

  // ─── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = async (auto = false) => {
    if (isSubmitting || isSubmitted) return;
    if (!submissionId) { alert('Lỗi phiên thi. Vui lòng thử lại.'); return; }
    setIsSubmitting(true);
    setShowConfirm(false);
    try {
      const merged = mergeAnswers(mcAnswers, tfAnswers, saAnswers);
      const submission = await submitExam(
        submissionId, merged, exam,
        { tabSwitchCount, tabSwitchWarnings: tabWarnings, autoSubmitted: auto },
      );
      if (submission) { setIsSubmitted(true); onSubmitted(submission); }
    } catch (err) {
      console.error(err);
      alert('Có lỗi khi nộp bài. Vui lòng thử lại.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAutoSubmit = useCallback(() => handleSubmit(true), []);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-gray-100 overflow-hidden">

      {/* ── Top bar ── */}
      <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-2 shrink-0 z-10 shadow-sm">
        <button
          onClick={onExit}
          className="text-gray-500 hover:text-gray-700 text-xs px-2 py-1 border border-gray-200 rounded-lg shrink-0"
        >
          ✕
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-gray-800 text-sm truncate">{exam.title}</p>
          <p className="text-xs text-gray-500 truncate">
            {student.name}{student.className ? ` · ${student.className}` : ''}
          </p>
        </div>

        {/* ✅ Nút mở Drive PDF ra tab mới (nếu có Drive URL) */}
        {drivePdfUrl && (
          <a
            href={drivePdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center gap-1 shrink-0 text-xs text-blue-600 border border-blue-200
              px-2 py-1 rounded-lg hover:bg-blue-50 transition"
            title="Mở đề thi full tab"
          >
            🔗 Mở Drive
          </a>
        )}

        {/* Progress — desktop only */}
        <div className="hidden sm:flex items-center gap-2 shrink-0">
          <div className="w-28 bg-gray-200 rounded-full h-2">
            <div
              className="bg-teal-500 h-2 rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-gray-600">{totalAnswered}/{totalQ}</span>
        </div>

        {/* Timer */}
        <div className={`font-mono font-bold px-2.5 py-1.5 rounded-lg text-sm shrink-0
          ${timerRed ? 'bg-red-100 text-red-700 animate-pulse' : 'bg-teal-100 text-teal-800'}`}>
          ⏱ {formatTimer(timeLeft)}
        </div>

        {/* Submit */}
        <button
          onClick={() => setShowConfirm(true)}
          disabled={isSubmitting || isSubmitted}
          className="shrink-0 px-3 py-1.5 bg-teal-600 text-white rounded-lg text-sm font-semibold
            disabled:opacity-50 hover:bg-teal-700 transition"
        >
          {isSubmitting ? '⏳' : '📤 Nộp'}
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          LAYOUT CHÍNH — split trái/phải
      ══════════════════════════════════════════════════════════════════════ */}
      <div
        ref={containerRef}
        className="flex-1 flex flex-row overflow-hidden"
        onPointerMove={dragHandleProps.onPointerMove}
        onPointerUp={dragHandleProps.onPointerUp}
      >
        {/* ── PDF panel ── */}
        <div
          className="overflow-hidden bg-gray-800 shrink-0 flex flex-col"
          style={{ width: `${splitPct}%` }}
        >
          {/* ✅ Ưu tiên Drive iframe — không tải base64, load nhanh hơn */}
          {drivePreviewUrl ? (
            <iframe
              src={drivePreviewUrl}
              className="w-full h-full border-0"
              title="Đề thi PDF"
              allow="autoplay"
            />
          ) : pdfBase64 ? (
            // Fallback: embed base64 (đề cũ trước khi nâng cấp)
            <embed
              src={`data:application/pdf;base64,${pdfBase64}`}
              type="application/pdf"
              className="w-full h-full"
              title="Đề thi PDF"
            />
          ) : (
            // Không có PDF
            <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
              <span className="text-5xl">📄</span>
              <p className="text-sm">Không tìm thấy file PDF</p>
              {drivePdfUrl && (
                <a href={drivePdfUrl} target="_blank" rel="noopener noreferrer"
                  className="text-blue-400 underline text-sm">
                  Mở Drive →
                </a>
              )}
            </div>
          )}
        </div>

        {/* ── Drag handle dọc ── */}
        <div
          className="shrink-0 relative select-none touch-none z-20 flex flex-col"
          style={{ width: '24px' }}
          onPointerDown={dragHandleProps.onPointerDown}
          onPointerMove={dragHandleProps.onPointerMove}
          onPointerUp={dragHandleProps.onPointerUp}
        >
          <div className="absolute inset-0 bg-gray-200 cursor-col-resize flex items-center justify-center">
            <div className="flex flex-col gap-1">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="w-1 h-1 rounded-full bg-gray-400" />
              ))}
            </div>
          </div>

          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 pointer-events-none">
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => snapTo(78)}
              className="pointer-events-auto w-5 h-5 bg-white border border-gray-300 rounded
                text-gray-500 flex items-center justify-center shadow-sm active:bg-gray-100"
              title="Phóng to đề"
              style={{ fontSize: '8px' }}
            >◀</button>
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => snapTo(62)}
              className="pointer-events-auto w-5 h-5 bg-white border border-gray-300 rounded
                text-gray-500 flex items-center justify-center shadow-sm active:bg-gray-100"
              title="Mặc định"
              style={{ fontSize: '8px' }}
            >●</button>
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => snapTo(45)}
              className="pointer-events-auto w-5 h-5 bg-white border border-gray-300 rounded
                text-gray-500 flex items-center justify-center shadow-sm active:bg-gray-100"
              title="Chia đều"
              style={{ fontSize: '8px' }}
            >▶</button>
          </div>
        </div>

        {/* ── Answer panel ── */}
        <div className="flex-1 overflow-y-auto bg-white min-w-0">
          <AnswerPanel
            mcQuestions={mcQuestions}
            tfQuestions={tfQuestions}
            saQuestions={saQuestions}
            mcAnswers={mcAnswers}
            tfAnswers={tfAnswers}
            saAnswers={saAnswers}
            answeredMC={answeredMC}
            answeredTF={answeredTF}
            answeredSA={answeredSA}
            isSubmitted={isSubmitted}
            isSubmitting={isSubmitting}
            // ✅ Truyền Drive URL để hiển thị sau khi nộp
            pdfDriveUrl={drivePdfUrl}
            onMC={setMC}
            onTF={setTF}
            onSA={setSA}
            onSubmit={() => setShowConfirm(true)}
          />
        </div>
      </div>

      {/* ── Tab warning ── */}
      {showTabWarning && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50
          bg-red-600 text-white px-6 py-3 rounded-xl shadow-2xl text-sm font-semibold">
          ⚠️ Cảnh báo: Chuyển tab bị phát hiện ({tabSwitchCount} lần)!
        </div>
      )}

      {/* ── Confirm dialog ── */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold text-gray-800 mb-2">📤 Xác nhận nộp bài</h3>
            <div className="text-sm text-gray-600 space-y-1 mb-4">
              <p>Bạn đã trả lời: <strong>{totalAnswered}/{totalQ}</strong> câu</p>
              {totalAnswered < totalQ && (
                <p className="text-orange-600">⚠ Còn {totalQ - totalAnswered} câu chưa làm</p>
              )}
              <p>Thời gian còn lại: <strong>{formatTimer(timeLeft)}</strong></p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50"
              >
                Làm tiếp
              </button>
              <button
                onClick={() => handleSubmit(false)}
                className="flex-1 py-2 bg-teal-600 text-white rounded-lg font-semibold hover:bg-teal-700"
              >
                Nộp bài
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── AnswerPanel ──────────────────────────────────────────────────────────────

interface AnswerPanelProps {
  mcQuestions: any[];
  tfQuestions: any[];
  saQuestions: any[];
  mcAnswers: MCAnswers;
  tfAnswers: TFAnswers;
  saAnswers: SAAnswers;
  answeredMC: number;
  answeredTF: number;
  answeredSA: number;
  isSubmitted: boolean;
  isSubmitting: boolean;
  pdfDriveUrl?: string;    // ✅ hiển thị link sau khi nộp
  onMC: (qNum: number, letter: string) => void;
  onTF: (qNum: number, idx: number, val: string) => void;
  onSA: (qNum: number, val: string) => void;
  onSubmit: () => void;
}

const AnswerPanel: React.FC<AnswerPanelProps> = ({
  mcQuestions, tfQuestions, saQuestions,
  mcAnswers, tfAnswers, saAnswers,
  answeredMC, answeredTF, answeredSA,
  isSubmitted, isSubmitting,
  pdfDriveUrl,
  onMC, onTF, onSA, onSubmit,
}) => (
  <div className="p-4 space-y-6">

    {/* ✅ Banner link Drive sau khi nộp bài */}
    {isSubmitted && pdfDriveUrl && (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-start gap-3">
        <span className="text-2xl">📎</span>
        <div>
          <p className="text-sm font-semibold text-blue-800">Xem lại đề thi</p>
          <a
            href={pdfDriveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 underline break-all hover:text-blue-800"
          >
            {pdfDriveUrl}
          </a>
        </div>
      </div>
    )}

    {/* PHẦN I – MC */}
    {mcQuestions.length > 0 && (
      <section>
        <h3 className="text-sm font-bold text-blue-700 border-b border-blue-100 pb-1 mb-3">
          🔘 PHẦN I — Trắc nghiệm ({answeredMC}/{mcQuestions.length})
        </h3>
        <div className="grid grid-cols-1 gap-2">
          {mcQuestions.map(q => (
            <div key={q.number} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
              <span className="text-sm font-semibold text-gray-500 w-12 shrink-0">Câu {q.number}</span>
              <div className="flex gap-1.5 flex-wrap">
                {['A', 'B', 'C', 'D'].map(l => (
                  <button
                    key={l}
                    onClick={() => onMC(q.number, l)}
                    disabled={isSubmitted}
                    className={`w-9 h-9 rounded-full text-sm font-bold transition
                      ${optionBg(l, mcAnswers[q.number] === l)}`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    )}

    {/* PHẦN II – TF */}
    {tfQuestions.length > 0 && (
      <section>
        <h3 className="text-sm font-bold text-purple-700 border-b border-purple-100 pb-1 mb-3">
          ☑️ PHẦN II — Đúng/Sai ({answeredTF}/{tfQuestions.length})
        </h3>
        <div className="space-y-3">
          {tfQuestions.map((q, idx) => {
            const cells = tfAnswers[q.number] || ['', '', '', ''];
            return (
              <div key={q.number} className="bg-purple-50 rounded-xl p-3">
                <p className="text-sm font-bold text-purple-800 mb-2">Câu {idx + 1}</p>
                <div className="grid grid-cols-4 gap-2">
                  {['a', 'b', 'c', 'd'].map((lbl, i) => (
                    <div key={lbl} className="flex flex-col items-center gap-1">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white
                        ${['bg-pink-500', 'bg-sky-500', 'bg-green-500', 'bg-orange-500'][i]}`}>
                        {lbl.toUpperCase()}
                      </div>
                      <div className="flex gap-1">
                        {['Đ', 'S'].map(v => (
                          <button
                            key={v}
                            onClick={() => onTF(q.number, i, v)}
                            disabled={isSubmitted}
                            className={`px-2 py-0.5 rounded text-xs font-bold transition
                              ${cells[i] === v
                                ? v === 'Đ' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
                                : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-100'}`}
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    )}

    {/* PHẦN III – SA */}
    {saQuestions.length > 0 && (
      <section>
        <h3 className="text-sm font-bold text-orange-700 border-b border-orange-100 pb-1 mb-3">
          ✍️ PHẦN III — Trả lời ngắn ({answeredSA}/{saQuestions.length})
        </h3>
        <div className="space-y-2">
          {saQuestions.map((q, idx) => (
            <div key={q.number} className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-500 w-16 shrink-0">Câu {idx + 1}</span>
              <input
                type="text"
                disabled={isSubmitted}
                value={saAnswers[q.number] || ''}
                onChange={e => onSA(q.number, e.target.value)}
                placeholder="Nhập kết quả..."
                className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm
                  focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:bg-gray-100"
              />
            </div>
          ))}
        </div>
      </section>
    )}

    {/* Submit button */}
    <button
      onClick={onSubmit}
      disabled={isSubmitting || isSubmitted}
      className="w-full py-3 bg-teal-600 text-white rounded-xl font-bold text-sm
        disabled:opacity-50 hover:bg-teal-700 transition"
    >
      {isSubmitted ? '✅ Đã nộp bài' : isSubmitting ? '⏳ Đang nộp...' : '📤 Nộp bài'}
    </button>
  </div>
);

export default PDFExamRoom;
