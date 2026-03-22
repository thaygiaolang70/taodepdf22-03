/**
 * Scoring Service v2 - Hệ thống tính điểm linh hoạt
 *
 * Hỗ trợ cấu hình điểm tùy chỉnh cho từng phần
 */

import { Exam, Question, ScoreBreakdown, ExamPointsConfig, SectionPointsConfig, TrueFalseMode } from '../types';

// Re-export để các component import được
export type { TrueFalseMode };

/**
 * Map QuestionType sang SectionPointsConfig questionType
 */
function mapQuestionType(type: string): 'multiple_choice' | 'true_false' | 'short_answer' {
  if (type === 'true_false') return 'true_false';
  if (type === 'short_answer' || type === 'writing') return 'short_answer';
  return 'multiple_choice';
}

/**
 * Phát hiện các section từ danh sách câu hỏi
 */
export function detectSections(questions: Question[]): SectionPointsConfig[] {
  const sections: SectionPointsConfig[] = [];
  const sectionMap = new Map<
    string,
    {
      type: 'multiple_choice' | 'true_false' | 'short_answer';
      count: number;
      part: number;
    }
  >();

  questions.forEach((q) => {
    const part = Math.floor(q.number / 100) || 1;
    const mappedType = mapQuestionType(q.type || 'multiple_choice');
    const key = `part${part}`;

    if (!sectionMap.has(key)) {
      sectionMap.set(key, { type: mappedType, count: 0, part });
    }
    sectionMap.get(key)!.count++;
  });

  sectionMap.forEach((data, key) => {
    const sectionNames: { [k: number]: string } = {
      1: 'PHẦN 1. TRẮC NGHIỆM NHIỀU LỰA CHỌN',
      2: 'PHẦN 2. TRẮC NGHIỆM ĐÚNG SAI',
      3: 'PHẦN 3. TRẢ LỜI NGẮN'
    };

    sections.push({
      sectionId: key,
      sectionName: sectionNames[data.part] || `Phần ${data.part}`,
      questionType: data.type,
      totalQuestions: data.count,
      totalPoints: 0,
      pointsPerQuestion: 0,
      // ✅ Mặc định dùng thang bậc BGD cho Đúng/Sai
      trueFalseMode: data.type === 'true_false' ? 'stepped' : undefined
    });
  });

  return sections.sort((a, b) => {
    const partA = parseInt(a.sectionId.replace('part', ''));
    const partB = parseInt(b.sectionId.replace('part', ''));
    return partA - partB;
  });
}

/**
 * Tạo cấu hình điểm mặc định (thang 10)
 */
export function createDefaultPointsConfig(questions: Question[]): ExamPointsConfig {
  const sections = detectSections(questions);
  const maxScore = 10;
  const totalQuestions = Math.max(questions.length, 1);

  sections.forEach((section) => {
    const ratio = section.totalQuestions / totalQuestions;
    section.totalPoints = parseFloat((maxScore * ratio).toFixed(2));
    section.pointsPerQuestion = parseFloat((section.totalPoints / section.totalQuestions).toFixed(4));
  });

  // Điều chỉnh để tổng = maxScore
  const currentTotal = sections.reduce((sum, s) => sum + s.totalPoints, 0);
  if (sections.length > 0 && Math.abs(currentTotal - maxScore) > 0.01) {
    const diff = maxScore - currentTotal;
    const last = sections.length - 1;
    sections[last].totalPoints = parseFloat((sections[last].totalPoints + diff).toFixed(2));
    sections[last].pointsPerQuestion = parseFloat(
      (sections[last].totalPoints / sections[last].totalQuestions).toFixed(4)
    );
  }

  return { maxScore, sections, autoBalance: false };
}

/**
 * Cập nhật cấu hình điểm khi người dùng thay đổi
 */
export function updateSectionPoints(
  config: ExamPointsConfig,
  sectionId: string,
  newTotalPoints: number
): ExamPointsConfig {
  const sections = config.sections.map((s) => {
    if (s.sectionId === sectionId) {
      return {
        ...s,
        totalPoints: newTotalPoints,
        pointsPerQuestion: parseFloat((newTotalPoints / s.totalQuestions).toFixed(4))
      };
    }
    return s;
  });
  return { ...config, sections };
}

/**
 * Tính điểm cho câu Đúng/Sai
 *
 * mode = 'equal'   → mỗi ý đúng = maxPoints / 4  (chia đều)
 * mode = 'stepped' → thang bậc BGD:
 *   1 ý đúng  →  10%
 *   2 ý đúng  →  25%
 *   3 ý đúng  →  50%
 *   4 ý đúng  → 100%
 *   0 ý đúng  →   0%
 */
export function calculateTrueFalsePoints(
  correctCount: number,
  maxPointsPerQuestion: number,
  mode: TrueFalseMode = 'equal'
): number {
  if (correctCount <= 0) return 0;

  let ratio: number;

  if (mode === 'stepped') {
    // Thang bậc BGD
    const steppedRatios: Record<number, number> = {
      1: 0.10,
      2: 0.25,
      3: 0.50,
      4: 1.00
    };
    ratio = steppedRatios[correctCount] ?? 0;
  } else {
    // Chia đều
    ratio = correctCount / 4;
  }

  return parseFloat((maxPointsPerQuestion * ratio).toFixed(4));
}

/**
 * Chuẩn hóa đáp án
 */
function normalizeAnswer(answer: string): string {
  return answer.toLowerCase().replace(/\s+/g, '').replace(/,/g, '.').trim();
}

/**
 * Lấy cấu hình điểm cho một câu hỏi
 */
function getQuestionPointsConfig(
  question: Question,
  config?: ExamPointsConfig
): { points: number; tfMode: TrueFalseMode } {
  const defaultTfMode: TrueFalseMode = 'equal';

  if (!config) {
    const mappedType = mapQuestionType(question.type || 'multiple_choice');
    if (mappedType === 'multiple_choice') return { points: 0.25, tfMode: defaultTfMode };
    if (mappedType === 'true_false') return { points: 1.0, tfMode: defaultTfMode };
    if (mappedType === 'short_answer') return { points: 0.5, tfMode: defaultTfMode };
    return { points: 0, tfMode: defaultTfMode };
  }

  const part = Math.floor(question.number / 100) || 1;
  const sectionId = `part${part}`;
  const section = config.sections.find((s) => s.sectionId === sectionId);

  return {
    points: section?.pointsPerQuestion || 0,
    tfMode: section?.trueFalseMode ?? defaultTfMode
  };
}

/**
 * Tính điểm chi tiết cho bài làm (V2 - Linh hoạt)
 */
export function calculateScore(
  answers: { [questionNumber: number]: string },
  exam: Exam
): ScoreBreakdown {
  const config = exam.pointsConfig;

  const breakdown: ScoreBreakdown = {
    multipleChoice: { total: 0, correct: 0, points: 0, pointsPerQuestion: 0 },
    trueFalse: { total: 0, correct: 0, partial: 0, points: 0, pointsPerQuestion: 0, details: {} },
    shortAnswer: { total: 0, correct: 0, points: 0, pointsPerQuestion: 0 },
    totalScore: 0,
    percentage: 0
  };

  let mcPoints = 0, mcCount = 0;
  let tfPoints = 0, tfCount = 0;
  let saPoints = 0, saCount = 0;

  exam.questions.forEach((q) => {
    const userAnswer = answers[q.number];
    const correctAnswer = q.correctAnswer;
    const { points: pointsPerQuestion, tfMode } = getQuestionPointsConfig(q, config);
    const mappedType = mapQuestionType(q.type || 'multiple_choice');

    // === TRẮC NGHIỆM ===
    if (mappedType === 'multiple_choice') {
      breakdown.multipleChoice.total++;
      mcCount++;
      mcPoints += pointsPerQuestion;

      if (userAnswer && correctAnswer) {
        if (userAnswer.toUpperCase() === correctAnswer.toUpperCase()) {
          breakdown.multipleChoice.correct++;
          breakdown.multipleChoice.points += pointsPerQuestion;
        }
      }
    }

    // === ĐÚNG SAI ===
    else if (mappedType === 'true_false') {
      breakdown.trueFalse.total++;
      tfCount++;
      tfPoints += pointsPerQuestion;

      if (correctAnswer) {
        const correctStatements = correctAnswer
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        // ✅ FIX: Học sinh không trả lời → 0 điểm, KHÔNG suy luận "chọn Sai hết"
        // (tránh bug: để trống vẫn được điểm vì vô tình "đúng" các ý có đáp án là Sai)
        const isBlank =
          !userAnswer ||
          userAnswer.trim() === '' ||
          userAnswer === '{}' ||
          userAnswer === 'null';

        if (isBlank) {
          breakdown.trueFalse.details[q.number] = { correctCount: 0, points: 0 };
          // correctCount = 0 → không tăng correct/partial
        } else {
          // Parse userAnswer: JSON object {"a":true,"b":false,...} hoặc chuỗi "a,b"
          let userStatements: string[] = [];
          try {
            const parsed = JSON.parse(userAnswer);
            userStatements = Object.keys(parsed)
              .filter((key) => parsed[key] === true)
              .map((key) => key.toLowerCase());
          } catch {
            userStatements = userAnswer
              .toLowerCase()
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
          }

          let correctCount = 0;
          for (const stmt of ['a', 'b', 'c', 'd']) {
            const shouldBeTrue = correctStatements.includes(stmt);
            const userSaidTrue = userStatements.includes(stmt);
            if (shouldBeTrue === userSaidTrue) correctCount++;
          }

          const points = calculateTrueFalsePoints(correctCount, pointsPerQuestion, tfMode);
          breakdown.trueFalse.points += points;
          breakdown.trueFalse.details[q.number] = { correctCount, points };

          if (correctCount === 4) breakdown.trueFalse.correct++;
          else if (correctCount > 0) breakdown.trueFalse.partial++;
        }
      }
    }

    // === TRẢ LỜI NGẮN ===
    else if (mappedType === 'short_answer') {
      breakdown.shortAnswer.total++;
      saCount++;
      saPoints += pointsPerQuestion;

      if (userAnswer && correctAnswer) {
        const normalizedUser = normalizeAnswer(userAnswer);
        const normalizedCorrect = normalizeAnswer(correctAnswer);

        if (normalizedUser === normalizedCorrect) {
          breakdown.shortAnswer.correct++;
          breakdown.shortAnswer.points += pointsPerQuestion;
        }
      }
    }
  });

  breakdown.multipleChoice.pointsPerQuestion = mcCount > 0 ? mcPoints / mcCount : 0;
  breakdown.trueFalse.pointsPerQuestion = tfCount > 0 ? tfPoints / tfCount : 0;
  breakdown.shortAnswer.pointsPerQuestion = saCount > 0 ? saPoints / saCount : 0;

  const total =
    breakdown.multipleChoice.points +
    breakdown.trueFalse.points +
    breakdown.shortAnswer.points;

  breakdown.totalScore = parseFloat(total.toFixed(4));

  const maxScore = config?.maxScore || 10;
  const pct = Math.round((breakdown.totalScore / maxScore) * 100);
  breakdown.percentage = Math.max(0, Math.min(100, pct));

  return breakdown;
}

export function formatScore(score: number): string {
  return score.toFixed(2);
}

export function getGrade(percentage: number): {
  grade: string;
  color: string;
  emoji: string;
  label: string;
  bg: string;
} {
  if (percentage >= 90) return { grade: 'A+', color: 'text-green-600', bg: 'bg-green-100', emoji: '🏆', label: 'Xuất sắc' };
  if (percentage >= 80) return { grade: 'A',  color: 'text-green-600', bg: 'bg-green-100', emoji: '🌟', label: 'Giỏi' };
  if (percentage >= 70) return { grade: 'B+', color: 'text-blue-600',  bg: 'bg-blue-100',  emoji: '👍', label: 'Khá' };
  if (percentage >= 60) return { grade: 'B',  color: 'text-blue-600',  bg: 'bg-blue-100',  emoji: '📚', label: 'Trung bình khá' };
  if (percentage >= 50) return { grade: 'C',  color: 'text-yellow-600',bg: 'bg-yellow-100',emoji: '💪', label: 'Trung bình' };
  if (percentage >= 40) return { grade: 'D',  color: 'text-orange-600',bg: 'bg-orange-100',emoji: '📖', label: 'Yếu' };
  return { grade: 'F', color: 'text-red-600', bg: 'bg-red-100', emoji: '😞', label: 'Kém' };
}

export function getTotalCorrectCount(breakdown: ScoreBreakdown): number {
  return breakdown.multipleChoice.correct + breakdown.trueFalse.correct + breakdown.shortAnswer.correct;
}

export function getTotalWrongCount(breakdown: ScoreBreakdown, totalQuestions: number): number {
  return totalQuestions - getTotalCorrectCount(breakdown);
}

export function validatePointsConfig(config: ExamPointsConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.maxScore <= 0) errors.push('Thang điểm phải lớn hơn 0');

  const totalPoints = config.sections.reduce((sum, s) => sum + s.totalPoints, 0);
  if (Math.abs(totalPoints - config.maxScore) > 0.01) {
    errors.push(
      `Tổng điểm các phần (${totalPoints.toFixed(2)}) phải bằng thang điểm (${config.maxScore})`
    );
  }

  config.sections.forEach((section) => {
    if (section.totalPoints < 0)
      errors.push(`Điểm phần "${section.sectionName}" không được âm`);
    if (section.totalQuestions <= 0)
      errors.push(`Số câu hỏi phần "${section.sectionName}" phải lớn hơn 0`);
  });

  return { valid: errors.length === 0, errors };
}
