// ============ ENUMS ============

export enum Role {
  STUDENT = 'student',
  TEACHER = 'teacher',
  ADMIN = 'admin',
  MEMBER = 'member',
  DEPUTY = 'deputy',
  LEADER = 'leader'
}

// ============ QUESTION TYPES ============

export type QuestionType =
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'
  | 'writing'
  | 'unknown';

// ============ IMAGE DATA ============

export interface ImageData {
  id: string;
  filename: string;
  base64: string;
  contentType: string;
  rId?: string;
}

// ============ USER ============

export interface User {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  role: Role;
  status?: 'online' | 'offline' | 'busy';
  isApproved?: boolean;
  createdAt?: Date;
  classIds?: string[];
}

// ============ CLASS ============

export interface Class {
  id: string;
  name: string;
  grade?: string;
  subject?: string;
  teacherId: string;
  teacherName: string;
  studentIds: string[];
  totalStudents: number;
  createdAt?: Date;
  updatedAt?: Date;
}

// ============ STUDENT INFO ============

export interface StudentInfo {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  className?: string;
  classId?: string;
  studentId?: string;
}

// ============ QUESTION & OPTIONS ============

export interface QuestionOption {
  letter: string;
  text: string;
  textWithUnderline?: string;
  isCorrect?: boolean;
}

export interface SectionInfo {
  letter: string;
  name: string;
  points: string;
}

export interface Question {
  number: number;
  text: string;
  type: QuestionType;
  options: QuestionOption[];
  correctAnswer: string | null;
  section?: SectionInfo;
  part?: string;
  passage?: string;
  solution?: string;
  images?: ImageData[];
  tfStatements?: { [key: string]: string };
}

// ============ EXAM SECTION ============

export interface ExamSection {
  name: string;
  description: string;
  points: string;
  readingPassage?: string;
  questions: Question[];
  sectionType?: QuestionType;
}

// ============ EXAM DATA ============

export interface ExamData {
  title: string;
  subject?: 'math' | 'english' | 'other';
  timeLimit?: number;
  sections: ExamSection[];
  questions: Question[];
  answers: { [key: number]: string };
  images?: ImageData[];
}

// ============ FLEXIBLE SCORING SYSTEM ============

export type TrueFalseMode = 'equal' | 'stepped';

export interface SectionPointsConfig {
  sectionId: string;
  sectionName: string;
  questionType: 'multiple_choice' | 'true_false' | 'short_answer';
  totalQuestions: number;
  totalPoints: number;
  pointsPerQuestion: number;
  trueFalseMode?: TrueFalseMode;
}

export interface ExamPointsConfig {
  maxScore: number;
  sections: SectionPointsConfig[];
  autoBalance?: boolean;
}

// ============ ROOM SETTINGS ============

export interface RoomSettings {
  allowLateJoin: boolean;
  showResultAfterSubmit: boolean;
  shuffleQuestions: boolean;
  maxAttempts: number;
  allowAnonymous: boolean;
  showCorrectAnswers: boolean;
  showExplanations: boolean;
  showAnswersAfterClose?: boolean;
  allowReview?: boolean;
}

// ============ ROOM ============

export interface Room {
  id: string;
  code: string;
  examId: string;
  examTitle: string;
  teacherId: string;
  teacherName: string;
  classId?: string;
  className?: string;
  status: 'waiting' | 'active' | 'closed';
  startTime?: Date;
  endTime?: Date;
  timeLimit: number;
  settings: RoomSettings;
  allowLateJoin?: boolean;
  showResultAfterSubmit?: boolean;
  shuffleQuestions?: boolean;
  maxAttempts?: number;
  allowAnonymous?: boolean;
  totalStudents: number;
  submittedCount: number;
  createdAt?: Date;
  updatedAt?: Date;
  opensAt?: Date;
  closesAt?: Date;
}

// ============ EXAM ============

export interface Exam {
  id: string;
  title: string;
  description?: string;
  subject?: string;
  timeLimit: number;
  questions: Question[];
  sections: ExamSection[];
  answers: { [key: number]: string };
  images?: ImageData[];
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
  pointsConfig?: ExamPointsConfig;

  // ✅ PDF lưu trên Google Drive (ưu tiên)
  pdfDriveUrl?: string;      // https://drive.google.com/file/d/{id}/view
  pdfDriveFileId?: string;   // File ID để tạo preview URL trong iframe

  // Backward compat — PDF base64 cũ lưu theo chunks trong subcollection
  hasPdfSubcollection?: boolean;
  pdfBase64?: string;        // runtime only, không lưu Firestore
}

// ============ SCORE BREAKDOWN ============

export interface ScoreBreakdown {
  multipleChoice: {
    total: number;
    correct: number;
    points: number;
    pointsPerQuestion?: number;
  };
  trueFalse: {
    total: number;
    correct: number;
    partial: number;
    points: number;
    pointsPerQuestion?: number;
    details: {
      [questionNumber: number]: {
        correctCount: number;
        points: number;
      };
    };
  };
  shortAnswer: {
    total: number;
    correct: number;
    points: number;
    pointsPerQuestion?: number;
  };
  totalScore: number;
  percentage: number;
}

// ============ SUBMISSION ============

export interface Submission {
  id: string;
  roomId: string;
  roomCode: string;
  examId: string;
  student: StudentInfo;
  answers: { [questionNumber: number]: string };
  scoreBreakdown: ScoreBreakdown;
  totalScore: number;
  percentage: number;
  score: number;
  correctCount: number;
  wrongCount: number;
  totalQuestions: number;
  tabSwitchCount: number;
  tabSwitchWarnings: Date[];
  autoSubmitted: boolean;
  startedAt?: Date;
  submittedAt?: Date;
  duration: number;
  status: 'in_progress' | 'submitted' | 'graded';
}

// ============ ROOM WITH EXAM ============

export interface RoomWithExam extends Room {
  exam: Exam;
}

// ============ LEADERBOARD ============

export interface LeaderboardEntry {
  rank: number;
  student: StudentInfo;
  score: number;
  percentage: number;
  duration: number;
  submittedAt?: Date;
  scoreBreakdown?: ScoreBreakdown;
}

// ============ CLASS JOIN REQUEST ============

export interface ClassJoinRequest {
  id: string;
  classId: string;
  className: string;
  studentId: string;
  studentName: string;
  studentEmail?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt?: Date;
  processedAt?: Date;
  processedBy?: string;
}
