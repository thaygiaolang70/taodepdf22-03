// src/components/ExamRoom.tsx

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Room, Exam, StudentInfo, Submission, Question, QuestionOption } from '../types';
import {
  auth,
  getExam,
  getRoom, // ✅ thêm để lấy lịch chính xác ngay lúc vào phòng
  createSubmission,
  submitExam,
  subscribeToRoom,
  ensureSignedIn
} from '../services/firebaseService';
import { getTabDetectionService } from '../services/tabDetectionService';
import MathText from './MathText';

/**
 * ExamRoom - Phòng thi Toán với MathJax + Hình ảnh + Chống gian lận
 */

interface ExamRoomProps {
  room: Room;
  student: StudentInfo;
  existingSubmissionId?: string;
  onSubmitted: (submission: Submission) => void;
  onExit: () => void;
}

const ExamRoom: React.FC<ExamRoomProps> = ({ room, student, existingSubmissionId, onSubmitted, onExit }) => {
  const [exam, setExam] = useState<Exam | null>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(existingSubmissionId || null);
  const [userAnswers, setUserAnswers] = useState<{ [key: number]: string }>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirmSubmit, setShowConfirmSubmit] = useState(false);

  const [roomStatus, setRoomStatus] = useState(room.status);
  const [roomLive, setRoomLive] = useState<Room>(room);

  // ✅ Anti-cheat
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [tabSwitchWarnings, setTabSwitchWarnings] = useState<Date[]>([]);
  const [showTabWarning, setShowTabWarning] = useState(false);

  // ✅ Timer (ưu tiên closesAt nếu có)
  const [timeLeft, setTimeLeft] = useState(() => {
    if (room.closesAt) {
      return Math.max(0, Math.floor((room.closesAt.getTime() - Date.now()) / 1000));
    }
    return room.timeLimit * 60;
  });

  // ======= derived schedule flags =======
  const nowMs = Date.now();
  const opensAtMs = roomLive.opensAt ? roomLive.opensAt.getTime() : null;
  const closesAtMs = roomLive.closesAt ? roomLive.closesAt.getTime() : null;

  const notOpenedYet = opensAtMs != null && nowMs < opensAtMs;
  const alreadyClosedBySchedule = closesAtMs != null && nowMs >= closesAtMs;

  const inScheduleWindow =
    (opensAtMs == null || nowMs >= opensAtMs) &&
    (closesAtMs == null || nowMs < closesAtMs);

  // Load exam
  useEffect(() => {
    const loadExam = async () => {
      try {
        // ✅ đảm bảo luôn có auth (anonymous hoặc google)
        await ensureSignedIn();

        const uid = auth.currentUser?.uid; // ✅ uid thật của phiên hiện tại
        if (!uid) throw new Error('Auth missing (anonymous/google)');

        // ✅ lấy room mới nhất để có opensAt/closesAt ngay lập tức
        const latestRoom = await getRoom(room.id);
        if (latestRoom) {
          setRoomLive(latestRoom);
          setRoomStatus(latestRoom.status);

          // cập nhật timer theo closesAt nếu có
          if (latestRoom.closesAt) {
            const s = Math.max(0, Math.floor((latestRoom.closesAt.getTime() - Date.now()) / 1000));
            setTimeLeft(s);
          }
        }

        const examData = await getExam(room.examId);
        if (examData) {
          setExam(examData);

          // ✅ FIX QUAN TRỌNG:
          // Khi tạo submission, student.id PHẢI = auth.uid để rules update cho phép submitExam()
          const fixedStudent: StudentInfo = {
            ...student,
            id: uid // ✅ ép đúng uid
          };

          // ✅ chỉ tạo submission khi trong cửa sổ giờ & phòng chưa đóng
          const r = latestRoom ?? roomLive;
          const rOpens = r.opensAt ? r.opensAt.getTime() : null;
          const rCloses = r.closesAt ? r.closesAt.getTime() : null;
          const rNow = Date.now();

          const rNotOpen = rOpens != null && rNow < rOpens;
          const rClosedSchedule = rCloses != null && rNow >= rCloses;

          const rInWindow = (rOpens == null || rNow >= rOpens) && (rCloses == null || rNow < rCloses);

          if (!submissionId) {
            if (r.status === 'closed' || rNotOpen || rClosedSchedule || !rInWindow) {
              // chưa cho tạo submission
            } else {
              const newId = await createSubmission({
                roomId: room.id,
                roomCode: room.code,
                examId: room.examId,
                student: fixedStudent,
                answers: {},
                score: 0,
                correctCount: 0,
                wrongCount: 0,
                totalQuestions: examData.questions.length,
                percentage: 0,
                startedAt: new Date(),
                submittedAt: null as any,
                duration: 0,
                status: 'in_progress',
                // ✅ Anti-cheat fields
                scoreBreakdown: {
                  multipleChoice: { total: 0, correct: 0, points: 0 },
                  trueFalse: { total: 0, correct: 0, partial: 0, points: 0, details: {} },
                  shortAnswer: { total: 0, correct: 0, points: 0 },
                  totalScore: 0,
                  percentage: 0
                },
                totalScore: 0,
                tabSwitchCount: 0,
                tabSwitchWarnings: [],
                autoSubmitted: false
              });

              setSubmissionId(newId);
            }
          }
        }
      } catch (err) {
        console.error('Load exam error:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadExam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.examId]);

  // ✅ Tab Detection Service
  useEffect(() => {
    const tabService = getTabDetectionService();

    tabService.start({
      onTabSwitch: (count: number, warnings: Date[]) => {
        setTabSwitchCount(count);
        setTabSwitchWarnings(warnings);
        setShowTabWarning(true);

        setTimeout(() => setShowTabWarning(false), 5000);
      },
      onAutoSubmit: () => {
        handleSubmit(true, true);
      }
    });

    return () => {
      tabService.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe room status
  useEffect(() => {
    const unsub = subscribeToRoom(room.id, (r: Room | null) => {
      if (r) {
        setRoomLive(r);
        setRoomStatus(r.status);

        // sync timer by closesAt
        if (r.closesAt) {
          const s = Math.max(0, Math.floor((r.closesAt.getTime() - Date.now()) / 1000));
          setTimeLeft(s);
        }

        if (r.status === 'closed') handleSubmit(true, true);
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  // Timer (ưu tiên closesAt)
  useEffect(() => {
    const t = setInterval(() => {
      if (roomLive.closesAt) {
        const s = Math.max(0, Math.floor((roomLive.closesAt.getTime() - Date.now()) / 1000));
        if (s <= 0) {
          // tới giờ đóng
          handleSubmit(true, true);
          setTimeLeft(0);
        } else {
          setTimeLeft(s);
        }
        return;
      }

      setTimeLeft((p) => {
        if (p <= 1) {
          handleSubmit(true, true);
          return 0;
        }
        return p - 1;
      });
    }, 1000);

    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomLive.closesAt?.getTime(), submissionId, exam]);

  // ✅ Thời điểm học sinh bắt đầu làm bài (để tính đếm ngược bài thi riêng)
  const examStartRef = useRef<number>(Date.now());

  // ✅ Đếm ngược bài thi riêng (reactive state)
  const examTimeLimit = roomLive.timeLimit * 60;
  const [examTimeLeft, setExamTimeLeft] = useState<number>(() =>
    Math.max(0, examTimeLimit - Math.floor((Date.now() - examStartRef.current) / 1000))
  );

  // Cập nhật examTimeLeft mỗi giây (độc lập với timeLeft của phòng)
  useEffect(() => {
    const t = setInterval(() => {
      const elapsed = Math.floor((Date.now() - examStartRef.current) / 1000);
      const left = Math.max(0, examTimeLimit - elapsed);
      setExamTimeLeft(left);
      if (left <= 0) {
        clearInterval(t);
        handleSubmit(true, true); // hết giờ làm bài → tự nộp
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examTimeLimit]);

  // ✅ Format ngắn MM:SS (dùng cho đếm ngược bài thi < 1h)
  const formatMMSS = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  // ✅ Format thông minh: ngày/giờ/phút khi thời gian dài, MM:SS khi < 1h
  const formatTimeHuman = (s: number): { line1: string; line2?: string } => {
    if (s <= 0) return { line1: '0:00' };

    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;

    if (days >= 1) {
      return {
        line1: `${days} ngày ${hours}h`,
        line2: `${mins}p ${secs.toString().padStart(2, '0')}s`
      };
    }
    if (hours >= 1) {
      return {
        line1: `${hours}h ${mins.toString().padStart(2, '0')}m`,
        line2: `${secs.toString().padStart(2, '0')}s`
      };
    }
    // < 1 giờ: hiện MM:SS bình thường
    return { line1: `${mins}:${secs.toString().padStart(2, '0')}` };
  };

  // ✅ Xác định chế độ hiển thị timer
  // Nếu có closesAt và còn > timeLimit giây → hiện 2 tầng: giờ đóng phòng + đếm ngược bài thi
  const hasSchedule = !!roomLive.closesAt;
  const closingFar = hasSchedule && timeLeft > examTimeLimit; // phòng đóng sau khi bài thi hết giờ

  const handleAnswerChange = (qNum: number, ans: string) => {
    setUserAnswers((prev) => ({ ...prev, [qNum]: ans }));
  };

  const handleSubmit = async (force = false, auto = false) => {
    if (!force && !showConfirmSubmit) {
      setShowConfirmSubmit(true);
      return;
    }
    if (!exam || !submissionId) return;

    setIsSubmitting(true);
    setShowConfirmSubmit(false);

    try {
      await ensureSignedIn();

      const uid = auth.currentUser?.uid;
      if (!uid) throw new Error('Auth missing on submit');

      const result = await submitExam(submissionId, userAnswers, exam, {
        tabSwitchCount,
        tabSwitchWarnings,
        autoSubmitted: auto
      });

      onSubmitted(result);
    } catch (err: any) {
      console.error('Submit error:', err);

      const code = err?.code || err?.name || 'unknown';
      const msg = err?.message || String(err);

      alert(`Lỗi nộp bài!\n\n[${code}]\n${msg}`);

      try {
        await navigator.clipboard.writeText(`[${code}] ${msg}`);
      } catch {}
    } finally {
      setIsSubmitting(false);
    }
  };

  // Gom nhóm câu hỏi theo PHẦN
  const groupedQuestions = useMemo(() => {
    if (!exam?.questions) return [];

    const groups: { part: number; title: string; desc: string; questions: Question[] }[] = [];
    const partMap = new Map<number, Question[]>();

    for (const q of exam.questions) {
      const part = Math.floor(q.number / 100) || 1;
      if (!partMap.has(part)) partMap.set(part, []);
      partMap.get(part)!.push(q);
    }

    for (const [part, qs] of Array.from(partMap.entries()).sort((a, b) => a[0] - b[0])) {
      qs.sort((a, b) => a.number - b.number);

      const titles: { [k: number]: [string, string] } = {
        1: ['PHẦN 1. TRẮC NGHIỆM NHIỀU LỰA CHỌN', 'Chọn một phương án đúng A, B, C hoặc D'],
        2: ['PHẦN 2. TRẮC NGHIỆM ĐÚNG SAI', 'Chọn Đúng hoặc Sai cho mỗi mệnh đề'],
        3: ['PHẦN 3. TRẢ LỜI NGẮN', 'Điền đáp án số vào ô trống']
      };
      const [title, desc] = titles[part] || [`PHẦN ${part}`, ''];
      groups.push({ part, title, desc, questions: qs });
    }
    return groups;
  }, [exam]);

  const answeredCount = Object.keys(userAnswers).filter((k) => userAnswers[+k]).length;
  const totalQuestions = exam?.questions.length || 0;
  const progress = totalQuestions > 0 ? (answeredCount / totalQuestions) * 100 : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-teal-50 to-teal-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-teal-500 border-t-transparent mx-auto mb-4"></div>
          <p className="text-teal-700">Đang tải đề thi...</p>
        </div>
      </div>
    );
  }

  // ✅ trước giờ mở
  if (notOpenedYet) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-teal-50 to-teal-100 p-6">
        <div className="bg-white rounded-2xl shadow-xl p-6 max-w-md w-full text-center">
          <div className="text-6xl mb-3">⏳</div>
          <h3 className="text-xl font-bold">Phòng thi chưa mở</h3>
          <p className="text-gray-600 mt-2">
            Sẽ mở lúc: <b>{roomLive.opensAt?.toLocaleString()}</b>
          </p>
          <button onClick={onExit} className="mt-5 px-5 py-2 rounded-xl bg-teal-600 text-white font-semibold">
            Quay lại
          </button>
        </div>
      </div>
    );
  }

  // ✅ quá giờ đóng
  if (alreadyClosedBySchedule && roomStatus !== 'closed') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 to-red-100 p-6">
        <div className="bg-white rounded-2xl shadow-xl p-6 max-w-md w-full text-center">
          <div className="text-6xl mb-3">⛔</div>
          <h3 className="text-xl font-bold">Phòng thi đã hết giờ</h3>
          <p className="text-gray-600 mt-2">
            Đã đóng lúc: <b>{roomLive.closesAt?.toLocaleString()}</b>
          </p>
          <button onClick={onExit} className="mt-5 px-5 py-2 rounded-xl bg-teal-600 text-white font-semibold">
            Quay lại
          </button>
        </div>
      </div>
    );
  }

  if (!exam) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-teal-50 to-teal-100">
        <div className="text-center">
          <div className="text-6xl mb-4">❌</div>
          <p className="text-red-600">Không tìm thấy đề thi</p>
          <button onClick={onExit} className="mt-4 text-teal-600 underline">
            Quay lại
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500">
      {/* Header Sticky */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-700 text-white p-4 shadow-xl sticky top-0 z-50">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center">👤</div>
              <div>
                <p className="font-bold">{student.name}</p>
                <p className="text-sm text-teal-100">
                  {student.className && `Lớp ${student.className} • `}Mã: {room.code}
                  {!inScheduleWindow && roomLive.opensAt && ` • Mở: ${roomLive.opensAt.toLocaleString()}`}
                </p>
              </div>
            </div>

            {/* ✅ Timer thông minh: 2 tầng khi có lịch đóng phòng xa */}
            {closingFar ? (
              <div className="flex flex-col items-end gap-1">
                {/* Tầng 1: Thời gian đến lúc đóng phòng */}
                <div className="px-4 py-1.5 rounded-xl bg-white/20 text-center min-w-[120px]">
                  <div className="text-xs opacity-80">📅 Đóng phòng sau</div>
                  <div className="font-mono font-bold text-base leading-tight">
                    {formatTimeHuman(timeLeft).line1}
                  </div>
                  {formatTimeHuman(timeLeft).line2 && (
                    <div className="font-mono font-bold text-xs opacity-80">
                      {formatTimeHuman(timeLeft).line2}
                    </div>
                  )}
                </div>
                {/* Tầng 2: Đếm ngược bài thi */}
                <div className={`px-4 py-1.5 rounded-xl text-center min-w-[120px] ${examTimeLeft < 60 ? 'bg-red-500 animate-pulse' : 'bg-orange-500/80'}`}>
                  <div className="text-xs opacity-90">⏱ Bài thi còn</div>
                  <div className="text-2xl font-mono font-bold">{formatMMSS(examTimeLeft)}</div>
                </div>
              </div>
            ) : (
              /* Chế độ thường: chỉ hiện 1 timer */
              <div className={`px-5 py-2 rounded-xl text-center ${timeLeft < 60 ? 'bg-red-500 animate-pulse' : 'bg-white/20'}`}>
                <div className="text-xs">⏱ Còn lại</div>
                {(() => {
                  const fmt = formatTimeHuman(timeLeft);
                  return (
                    <>
                      <div className="text-2xl font-mono font-bold">{fmt.line1}</div>
                      {fmt.line2 && <div className="text-sm font-mono opacity-80">{fmt.line2}</div>}
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex justify-between text-sm mb-1">
                <span>
                  {answeredCount}/{totalQuestions} câu
                </span>
                <span>{Math.round(progress)}%</span>
              </div>
              <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-green-400 to-emerald-300 transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>

            <button
              onClick={() => setShowConfirmSubmit(true)}
              disabled={isSubmitting || !submissionId}
              className={`px-5 py-2 rounded-xl font-bold transition ${
                isSubmitting || !submissionId ? 'bg-orange-300 cursor-not-allowed' : 'bg-orange-500 hover:bg-orange-600'
              }`}
            >
              📤 Nộp bài
            </button>
          </div>
        </div>
      </div>

      {/* ✅ Tab Switch Warning */}
      {showTabWarning && (
        <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 animate-bounce">
          <div className="bg-red-500 text-white px-6 py-4 rounded-xl shadow-2xl font-bold">
            ⚠️ CẢNH BÁO: Phát hiện chuyển tab! ({tabSwitchCount}/2)
            {tabSwitchCount === 1 && <p className="text-sm mt-1">Lần tiếp theo sẽ tự động nộp bài!</p>}
          </div>
        </div>
      )}

      {roomStatus === 'closed' && (
        <div className="bg-red-500 text-white text-center py-2 font-bold">⚠️ Phòng thi đã đóng! Đang nộp bài tự động...</div>
      )}

      {!submissionId && (
        <div className="bg-yellow-500 text-white text-center py-2 font-bold">
          ⚠️ Chưa tạo được bài làm (có thể do phòng chưa tới giờ hoặc rules). Vui lòng thử tải lại khi đến giờ.
        </div>
      )}

      {/* Content */}
      <div className="max-w-4xl mx-auto p-4">
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
          <div className="bg-gradient-to-r from-teal-500 to-teal-600 text-white p-5 text-center">
            <h1 className="text-xl font-bold">{exam.title}</h1>
            <p className="text-teal-100 text-sm mt-1">Tổng: {totalQuestions} câu</p>
          </div>

          <div className="p-5">
            {groupedQuestions.map((group) => (
              <div key={group.part} className="mb-8">
                <div
                  className={`rounded-xl p-4 mb-4 text-white shadow-lg ${
                    group.part === 1
                      ? 'bg-gradient-to-r from-blue-500 to-blue-600'
                      : group.part === 2
                      ? 'bg-gradient-to-r from-emerald-500 to-emerald-600'
                      : 'bg-gradient-to-r from-orange-500 to-orange-600'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{group.part === 1 ? '📝' : group.part === 2 ? '✅' : '✏️'}</span>
                    <div>
                      <h2 className="font-bold">{group.title}</h2>
                      <p className="text-sm opacity-90">{group.desc}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  {group.questions.map((q) => (
                    <QuestionCard
                      key={q.number}
                      question={q}
                      displayNum={q.number % 100}
                      userAnswer={userAnswers[q.number]}
                      onChange={(ans) => handleAnswerChange(q.number, ans)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* sticky bottom */}
        <div className="sticky bottom-0 mt-4 p-4 bg-gradient-to-t from-black/70 via-black/50 to-transparent rounded-t-2xl">
          <div className="flex justify-center">
            <button
              onClick={() => setShowConfirmSubmit(true)}
              disabled={isSubmitting || !submissionId}
              className={`px-10 py-4 rounded-full font-bold text-lg shadow-2xl transition ${
                isSubmitting || !submissionId
                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                  : 'bg-gradient-to-r from-orange-500 to-red-500 text-white hover:scale-105'
              }`}
            >
              {isSubmitting ? '⏳ Đang nộp...' : '📤 Nộp bài'}
            </button>
          </div>
        </div>
      </div>

      {showConfirmSubmit && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="text-center mb-5">
              <div className="text-5xl mb-3">📝</div>
              <h3 className="text-xl font-bold">Xác nhận nộp bài?</h3>
              <p className="text-gray-600 mt-2">
                Đã trả lời <strong className="text-teal-600">{answeredCount}/{totalQuestions}</strong> câu
                {answeredCount < totalQuestions && (
                  <span className="block text-orange-500 mt-1">⚠️ Còn {totalQuestions - answeredCount} câu chưa làm!</span>
                )}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirmSubmit(false)}
                className="flex-1 py-3 rounded-xl font-semibold border-2 border-gray-300 hover:bg-gray-50"
              >
                Tiếp tục làm
              </button>
              <button
                onClick={() => handleSubmit(true)}
                disabled={isSubmitting || !submissionId}
                className={`flex-1 py-3 rounded-xl font-bold text-white ${
                  isSubmitting || !submissionId ? 'bg-gray-300 cursor-not-allowed' : 'bg-gradient-to-r from-orange-500 to-red-500'
                }`}
              >
                {isSubmitting ? '⏳...' : '✓ Nộp bài'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExamRoom;

// ============ QUESTION CARD ============

interface ImageData {
  id?: string;
  base64?: string;
  contentType?: string;
  rId?: string;
}

interface QuestionCardProps {
  question: Question;
  displayNum: number;
  userAnswer?: string;
  onChange: (ans: string) => void;
}

const QuestionCard: React.FC<QuestionCardProps> = ({ question, displayNum, userAnswer, onChange }) => {
  const qType = question.type || 'multiple_choice';
  const isAnswered = !!userAnswer;

  const questionImages: ImageData[] = (question as any).images || [];

  const imageUrls = useMemo(() => {
    return questionImages
      .map((img) => {
        if (img.base64) {
          const contentType = img.contentType || 'image/png';
          return img.base64.startsWith('data:') ? img.base64 : `data:${contentType};base64,${img.base64}`;
        }
        return null;
      })
      .filter(Boolean) as string[];
  }, [questionImages]);

  return (
    <div
      className={`bg-white border-2 rounded-xl overflow-hidden transition ${
        isAnswered ? 'border-teal-400 shadow-md' : 'border-gray-200 hover:border-gray-300'
      }`}
    >
      <div className="p-4 bg-gray-50 border-b flex items-start gap-3">
        <div
          className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-white text-sm flex-shrink-0 ${
            isAnswered ? 'bg-teal-500' : 'bg-gray-400'
          }`}
        >
          {displayNum}
        </div>

        <div className="flex-1">
          <MathText html={question.text} className="text-gray-800 leading-relaxed" block />

          {imageUrls.length > 0 && (
            <div className="mt-3 space-y-2">
              {imageUrls.map((url, idx) => (
                <div key={idx} className="flex justify-center">
                  <img
                    src={url}
                    alt={`Hình ${idx + 1} - Câu ${displayNum}`}
                    className="block max-w-full h-auto mx-auto rounded-lg shadow-md border border-gray-200"
                    style={{ maxHeight: '300px' }}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="p-4">
        {qType === 'multiple_choice' && question.options && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {question.options.map((opt: QuestionOption) => {
              const selected = userAnswer?.toUpperCase() === opt.letter.toUpperCase();
              return (
                <label
                  key={opt.letter}
                  className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition ${
                    selected ? 'border-teal-500 bg-teal-50' : 'border-gray-200 hover:border-teal-300 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name={`q${question.number}`}
                    value={opt.letter}
                    checked={selected}
                    onChange={(e) => onChange(e.target.value)}
                    className="hidden"
                  />
                  <span
                    className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${
                      selected ? 'bg-teal-500 text-white' : 'bg-gray-200 text-gray-600'
                    }`}
                  >
                    {opt.letter}
                  </span>
                  <MathText html={opt.text} className="flex-1 text-gray-700 text-sm" />
                </label>
              );
            })}
          </div>
        )}

        {qType === 'true_false' && question.options && (
          <div className="space-y-2">
            {question.options.map((opt: QuestionOption) => {
              const selected = (userAnswer?.split(',') || [])
                .map((s) => s.trim().toLowerCase())
                .includes(opt.letter.toLowerCase());
              const toggle = () => {
                const curr = (userAnswer?.split(',') || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
                const next = selected ? curr.filter((l) => l !== opt.letter.toLowerCase()) : [...curr, opt.letter.toLowerCase()];
                onChange(next.sort().join(','));
              };
              return (
                <div
                  key={opt.letter}
                  onClick={toggle}
                  className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition ${
                    selected ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:border-green-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={toggle}
                    className="w-5 h-5 accent-green-500"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className="px-2 py-0.5 bg-orange-500 text-white rounded text-sm font-bold">{opt.letter})</span>
                  <MathText html={opt.text} className="flex-1 text-gray-700 text-sm" />
                </div>
              );
            })}
          </div>
        )}

        {(qType === 'short_answer' || qType === 'writing') && (
          <div className="bg-gray-50 rounded-lg p-3">
            <input
              type="text"
              value={userAnswer || ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder="Nhập đáp án..."
              className="w-full p-3 border-2 border-gray-300 rounded-lg focus:border-teal-500 focus:outline-none"
            />
            <p className="text-xs text-gray-500 mt-2">💡 Nhập đáp án số (VD: 42 hoặc -3.5)</p>
          </div>
        )}
      </div>
    </div>
  );
};
