import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  DocumentData,
  writeBatch
} from 'firebase/firestore';
import { Exam, Room, Submission, StudentInfo, User, Role, Question, Class, ClassJoinRequest } from '../types';
import { calculateScore, getTotalCorrectCount, getTotalWrongCount } from './scoringService';

const firebaseConfig = {
  apiKey: "AIzaSyAcB408T-dgwVpxAKog5AUk4peZkONkWPM",
  authDomain: "taodepdf1503.firebaseapp.com",
  projectId: "taodepdf1503",
  storageBucket: "taodepdf1503.firebasestorage.app",
  messagingSenderId: "906406380218",
  appId: "1:906406380218:web:6d22613f58942290543883",
  measurementId: "G-9Y8ZQEX6ZB"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// ============ HELPER FUNCTIONS ============

const toDate = (timestamp: Timestamp | Date | undefined | null): Date | undefined => {
  if (!timestamp) return undefined;
  if (timestamp instanceof Timestamp) return timestamp.toDate();
  if (timestamp instanceof Date) return timestamp;
  return undefined;
};

const sanitizeForFirestore = (obj: any): any => {
  if (obj === undefined || obj === null) return null;
  try {
    return JSON.parse(JSON.stringify(obj, (_key, value) => {
      if (value === undefined) return null;
      if (typeof value === 'number' && (isNaN(value) || !isFinite(value))) return 0;
      if (typeof value === 'function') return undefined;
      return value;
    }));
  } catch {
    return null;
  }
};

const removeAllBase64 = (obj: any): any => {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (obj.includes('base64,') && obj.length > 2000) {
      return obj.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '');
    }
    return obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(item => removeAllBase64(item));
  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'base64') continue;
      cleaned[key] = removeAllBase64(value);
    }
    return cleaned;
  }
  return obj;
};

const extractImagesFromExam = (examData: any): {
  strippedData: any;
  imageDocuments: { questionNumber: number; imageIndex: number; id: string; filename: string; base64: string; contentType: string }[];
} => {
  const imageDocuments: any[] = [];

  const strippedQuestions = (examData.questions || []).map((q: any) => {
    if (!q.images || q.images.length === 0) return q;
    const strippedImages = q.images.map((img: any, idx: number) => {
      if (img.base64 && img.base64.length > 0) {
        imageDocuments.push({
          questionNumber: q.number,
          imageIndex: idx,
          id: img.id || `img_${idx}`,
          filename: img.filename || `image${idx}.png`,
          base64: img.base64,
          contentType: img.contentType || 'image/png'
        });
        return {
          id: img.id || `img_${idx}`,
          filename: img.filename || `image${idx}.png`,
          contentType: img.contentType || 'image/png'
        };
      }
      return img;
    });
    return { ...q, images: strippedImages };
  });

  const strippedExamImages = (examData.images || []).map((img: any, idx: number) => {
    if (img.base64 && img.base64.length > 0) {
      imageDocuments.push({
        questionNumber: 0,
        imageIndex: idx,
        id: img.id || `exam_img_${idx}`,
        filename: img.filename || `exam_image${idx}.png`,
        base64: img.base64,
        contentType: img.contentType || 'image/png'
      });
      return {
        id: img.id || `exam_img_${idx}`,
        filename: img.filename || `exam_image${idx}.png`,
        contentType: img.contentType || 'image/png'
      };
    }
    return img;
  });

  return {
    strippedData: { ...examData, questions: strippedQuestions, images: strippedExamImages },
    imageDocuments
  };
};

const mergeImagesIntoExam = (examData: any, imageDocs: any[]): any => {
  if (!imageDocs || imageDocs.length === 0) return examData;

  const imageMap = new Map<string, any[]>();
  for (const doc of imageDocs) {
    const key = `${doc.questionNumber}_${doc.imageIndex}_${doc.id}`;
    if (!imageMap.has(key)) imageMap.set(key, []);
    imageMap.get(key)!.push(doc);
  }

  const assembledImages: any[] = [];
  for (const [, chunks] of imageMap) {
    chunks.sort((a: any, b: any) => (a.chunkIndex || 0) - (b.chunkIndex || 0));
    const fullBase64 = chunks.map((c: any) => c.base64 || '').join('');
    assembledImages.push({
      questionNumber: chunks[0].questionNumber,
      imageIndex: chunks[0].imageIndex,
      id: chunks[0].id,
      filename: chunks[0].filename,
      base64: fullBase64,
      contentType: chunks[0].contentType || 'image/png'
    });
  }

  const questions = (examData.questions || []).map((q: any) => {
    const qImages = assembledImages
      .filter((img: any) => img.questionNumber === q.number)
      .sort((a: any, b: any) => (a.imageIndex || 0) - (b.imageIndex || 0));
    if (qImages.length > 0) {
      return {
        ...q,
        images: qImages.map((img: any) => ({
          id: img.id, filename: img.filename, base64: img.base64, contentType: img.contentType
        }))
      };
    }
    return q;
  });

  const examImages = assembledImages
    .filter((img: any) => img.questionNumber === 0)
    .sort((a: any, b: any) => (a.imageIndex || 0) - (b.imageIndex || 0))
    .map((img: any) => ({ id: img.id, filename: img.filename, base64: img.base64, contentType: img.contentType }));

  return {
    ...examData,
    questions,
    images: examImages.length > 0 ? examImages : examData.images
  };
};

// ============ PDF SUBCOLLECTION (backward compat) ============

const PDF_CHUNK_SIZE = 800000;

const savePDFToSubcollection = async (examId: string, pdfBase64: string): Promise<void> => {
  const totalChunks = Math.ceil(pdfBase64.length / PDF_CHUNK_SIZE);
  console.log(`📄 Saving PDF: ${pdfBase64.length} chars → ${totalChunks} chunk(s)`);
  for (let i = 0; i < totalChunks; i++) {
    const chunk = pdfBase64.substring(i * PDF_CHUNK_SIZE, (i + 1) * PDF_CHUNK_SIZE);
    await addDoc(collection(db, 'exams', examId, 'pdf'), { chunkIndex: i, totalChunks, data: chunk });
  }
  console.log(`✅ PDF saved to exams/${examId}/pdf/ (${totalChunks} chunk(s))`);
};

const loadPDFFromSubcollection = async (examId: string): Promise<string> => {
  const snap = await getDocs(collection(db, 'exams', examId, 'pdf'));
  if (snap.empty) return '';
  const chunks = snap.docs
    .map(d => d.data())
    .sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));
  return chunks.map(c => c.data || '').join('');
};

const deletePDFSubcollection = async (examId: string): Promise<void> => {
  try {
    const snap = await getDocs(collection(db, 'exams', examId, 'pdf'));
    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      console.log(`🗑️ Deleted PDF subcollection for exam ${examId}`);
    }
  } catch (err) {
    console.warn('deletePDFSubcollection error:', err);
  }
};

// ============ AUTH FUNCTIONS ============

export const signInWithGoogle = async (): Promise<User | null> => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const firebaseUser = result.user;

    const userRef = doc(db, 'users', firebaseUser.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      const hasUsers = await hasAnyUsers();
      const isFirstUser = !hasUsers;
      const newUser: User = {
        id: firebaseUser.uid,
        name: firebaseUser.displayName || 'Unknown',
        email: firebaseUser.email || undefined,
        avatar: firebaseUser.photoURL || undefined,
        role: isFirstUser ? Role.ADMIN : Role.TEACHER,
        isApproved: isFirstUser,
        createdAt: new Date(),
        classIds: []
      };
      await setDoc(userRef, { ...newUser, createdAt: serverTimestamp() });
      return newUser;
    }

    const userData = userSnap.data();
    return {
      id: userSnap.id,
      name: userData.name || '',
      email: userData.email,
      avatar: userData.avatar,
      role: userData.role || Role.TEACHER,
      isApproved: userData.isApproved ?? false,
      createdAt: toDate(userData.createdAt),
      classIds: userData.classIds || []
    };
  } catch (error) {
    console.error('Google sign in error:', error);
    throw error;
  }
};

export const signInStudentWithGoogle = async (): Promise<User | null> => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const firebaseUser = result.user;

    const userRef = doc(db, 'users', firebaseUser.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      const newStudent: User = {
        id: firebaseUser.uid,
        name: firebaseUser.displayName || 'Unknown',
        email: firebaseUser.email || undefined,
        avatar: firebaseUser.photoURL || undefined,
        role: Role.STUDENT,
        isApproved: false,
        createdAt: new Date(),
        classIds: []
      };
      await setDoc(userRef, { ...newStudent, createdAt: serverTimestamp() });
      return newStudent;
    }

    const userData = userSnap.data();
    const approved = userData.isApproved ?? false;
    if (!approved && userData.role !== Role.STUDENT) {
      await setDoc(userRef, { role: Role.STUDENT }, { merge: true });
    }
    return {
      id: userSnap.id,
      name: userData.name || '',
      email: userData.email,
      avatar: userData.avatar,
      role: Role.STUDENT,
      isApproved: userData.isApproved ?? false,
      createdAt: toDate(userData.createdAt),
      classIds: userData.classIds || []
    };
  } catch (error) {
    console.error('Student Google sign in error:', error);
    throw error;
  }
};

export const signOutUser = () => signOut(auth);

let anonymousSignInPromise: Promise<void> | null = null;

export const ensureSignedIn = async (): Promise<void> => {
  if (auth.currentUser) return;
  if (!anonymousSignInPromise) {
    anonymousSignInPromise = signInAnonymously(auth)
      .then(() => {})
      .finally(() => { anonymousSignInPromise = null; });
  }
  await anonymousSignInPromise;
};

export const hasAnyUsers = async (): Promise<boolean> => {
  const snapshot = await getDocs(collection(db, 'users'));
  return !snapshot.empty;
};

export const isUserAdmin = async (userId: string): Promise<boolean> => {
  const userRef = doc(db, 'users', userId);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    const role = userSnap.data().role;
    return role === Role.ADMIN || role === Role.LEADER;
  }
  return false;
};

export const getCurrentUser = async (): Promise<User | null> => {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) return null;
  const userRef = doc(db, 'users', firebaseUser.uid);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    const userData = userSnap.data();
    return {
      id: userSnap.id,
      name: userData.name || '',
      email: userData.email,
      avatar: userData.avatar,
      role: userData.role || Role.TEACHER,
      isApproved: userData.isApproved ?? false,
      createdAt: toDate(userData.createdAt),
      classIds: userData.classIds || []
    };
  }
  return null;
};

// ============ CLASS MANAGEMENT ============

export const createClass = async (classData: {
  name: string;
  grade?: string;
  subject?: string;
  teacherId: string;
  teacherName: string;
}): Promise<string> => {
  const newClass: Omit<Class, 'id'> = {
    name: classData.name,
    grade: classData.grade,
    subject: classData.subject,
    teacherId: classData.teacherId,
    teacherName: classData.teacherName,
    studentIds: [],
    totalStudents: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const classRef = await addDoc(collection(db, 'classes'), {
    ...newClass,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return classRef.id;
};

export const getAllClasses = async (): Promise<Class[]> => {
  const snapshot = await getDocs(collection(db, 'classes'));
  const classes = snapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      name: data.name || '',
      grade: data.grade,
      subject: data.subject,
      teacherId: data.teacherId || '',
      teacherName: data.teacherName || '',
      studentIds: data.studentIds || [],
      totalStudents: data.totalStudents || 0,
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt)
    };
  });
  classes.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  return classes;
};

export const getClassesByTeacher = async (teacherId: string): Promise<Class[]> => {
  const q = query(collection(db, 'classes'), where('teacherId', '==', teacherId));
  const snapshot = await getDocs(q);
  const classes = snapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      name: data.name || '',
      grade: data.grade,
      subject: data.subject,
      teacherId: data.teacherId || '',
      teacherName: data.teacherName || '',
      studentIds: data.studentIds || [],
      totalStudents: data.totalStudents || 0,
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt)
    };
  });
  classes.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  return classes;
};

export const getClass = async (classId: string): Promise<Class | null> => {
  const classRef = doc(db, 'classes', classId);
  const classSnap = await getDoc(classRef);
  if (classSnap.exists()) {
    const data = classSnap.data();
    return {
      id: classSnap.id,
      name: data.name || '',
      grade: data.grade,
      subject: data.subject,
      teacherId: data.teacherId || '',
      teacherName: data.teacherName || '',
      studentIds: data.studentIds || [],
      totalStudents: data.totalStudents || 0,
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt)
    };
  }
  return null;
};

export const addStudentToClass = async (classId: string, studentId: string): Promise<void> => {
  const classRef = doc(db, 'classes', classId);
  const classSnap = await getDoc(classRef);
  if (!classSnap.exists()) throw new Error('Class not found');

  const classData = classSnap.data();
  const studentIds = classData.studentIds || [];
  if (!studentIds.includes(studentId)) {
    studentIds.push(studentId);
    await updateDoc(classRef, { studentIds, totalStudents: studentIds.length, updatedAt: serverTimestamp() });

    const userRef = doc(db, 'users', studentId);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      const userData = userSnap.data();
      const userClassIds = userData.classIds || [];
      if (!userClassIds.includes(classId)) {
        userClassIds.push(classId);
        await updateDoc(userRef, { classIds: userClassIds });
      }
    }
  }
};

export const removeStudentFromClass = async (classId: string, studentId: string): Promise<void> => {
  const classRef = doc(db, 'classes', classId);
  const classSnap = await getDoc(classRef);
  if (!classSnap.exists()) return;

  const classData = classSnap.data();
  const studentIds = (classData.studentIds || []).filter((id: string) => id !== studentId);
  await updateDoc(classRef, { studentIds, totalStudents: studentIds.length, updatedAt: serverTimestamp() });

  const userRef = doc(db, 'users', studentId);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    const userData = userSnap.data();
    const userClassIds = (userData.classIds || []).filter((id: string) => id !== classId);
    await updateDoc(userRef, { classIds: userClassIds });
  }
};

export const deleteClass = async (classId: string): Promise<void> => {
  const classData = await getClass(classId);
  if (classData) {
    for (const studentId of classData.studentIds) {
      await removeStudentFromClass(classId, studentId);
    }
  }
  const requestsQuery = query(collection(db, 'classJoinRequests'), where('classId', '==', classId));
  const requestsSnap = await getDocs(requestsQuery);
  await Promise.all(requestsSnap.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, 'classes', classId));
};

export const getStudentsInClass = async (classId: string): Promise<User[]> => {
  const classData = await getClass(classId);
  if (!classData || classData.studentIds.length === 0) return [];
  const students: User[] = [];
  for (const studentId of classData.studentIds) {
    const userRef = doc(db, 'users', studentId);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      const data = userSnap.data();
      students.push({
        id: userSnap.id,
        name: data.name || '',
        email: data.email,
        avatar: data.avatar,
        role: data.role || Role.STUDENT,
        isApproved: data.isApproved ?? true,
        createdAt: toDate(data.createdAt),
        classIds: data.classIds || []
      });
    }
  }
  return students;
};

// ============ EXPORTS ============
export {
  onAuthStateChanged,
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit,
  Timestamp,
  serverTimestamp,
  addDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot
};

// ============ SUBMISSION FUNCTIONS ============

export const createSubmission = async (submission: Omit<Submission, 'id'>): Promise<string> => {
  const submissionRef = await addDoc(collection(db, 'submissions'), {
    ...submission,
    startedAt: serverTimestamp()
  });
  try {
    const roomRef = doc(db, 'rooms', submission.roomId);
    const roomSnap = await getDoc(roomRef);
    if (roomSnap.exists()) {
      const room = roomSnap.data();
      await updateDoc(roomRef, { totalStudents: (room.totalStudents || 0) + 1, updatedAt: serverTimestamp() });
    }
  } catch (e) {
    console.warn('createSubmission: không update được rooms.totalStudents. Bỏ qua.', e);
  }
  return submissionRef.id;
};

export const submitExam = async (
  submissionId: string,
  answers: { [key: number]: string },
  exam: Exam,
  antiCheatData?: { tabSwitchCount: number; tabSwitchWarnings: Date[]; autoSubmitted: boolean; }
): Promise<Submission> => {
  const submissionRef = doc(db, 'submissions', submissionId);
  const submissionSnap = await getDoc(submissionRef);
  if (!submissionSnap.exists()) throw new Error('Submission not found');

  const submissionData = submissionSnap.data();
  const scoreBreakdown = calculateScore(answers, exam);
  const totalScore = scoreBreakdown.totalScore;
  const percentage = scoreBreakdown.percentage;
  const correctCount = getTotalCorrectCount(scoreBreakdown);
  const totalQuestions = exam.questions.length;
  const wrongCount = getTotalWrongCount(scoreBreakdown, totalQuestions);

  let startedAt: Date;
  if (submissionData.startedAt instanceof Timestamp) {
    startedAt = submissionData.startedAt.toDate();
  } else if (submissionData.startedAt) {
    startedAt = new Date(submissionData.startedAt);
  } else {
    startedAt = new Date();
  }

  const submittedAt = new Date();
  const duration = Math.round((submittedAt.getTime() - startedAt.getTime()) / 1000);

  const updatedData = {
    answers, scoreBreakdown, totalScore, percentage,
    score: totalScore, correctCount, wrongCount, totalQuestions,
    submittedAt: serverTimestamp(),
    duration,
    status: 'submitted' as const,
    tabSwitchCount: antiCheatData?.tabSwitchCount || 0,
    tabSwitchWarnings: antiCheatData?.tabSwitchWarnings || [],
    autoSubmitted: antiCheatData?.autoSubmitted || false
  };

  await updateDoc(submissionRef, updatedData);

  try {
    const roomRef = doc(db, 'rooms', submissionData.roomId);
    const roomSnap = await getDoc(roomRef);
    if (roomSnap.exists()) {
      const room = roomSnap.data();
      await updateDoc(roomRef, { submittedCount: (room.submittedCount || 0) + 1, updatedAt: serverTimestamp() });
    }
  } catch (e) {
    console.warn('submitExam: không update được rooms.submittedCount. Bỏ qua.', e);
  }

  return {
    id: submissionId,
    roomId: submissionData.roomId,
    roomCode: submissionData.roomCode,
    examId: submissionData.examId,
    student: submissionData.student,
    answers, scoreBreakdown, totalScore, percentage,
    score: totalScore, correctCount, wrongCount, totalQuestions,
    tabSwitchCount: updatedData.tabSwitchCount,
    tabSwitchWarnings: updatedData.tabSwitchWarnings,
    autoSubmitted: updatedData.autoSubmitted,
    startedAt, submittedAt, duration,
    status: 'submitted'
  };
};

const parseSubmissionData = (id: string, data: DocumentData): Submission => {
  return {
    id,
    roomId: data.roomId || '',
    roomCode: data.roomCode || '',
    examId: data.examId || '',
    student: data.student || { id: '', name: '' },
    answers: data.answers || {},
    scoreBreakdown: data.scoreBreakdown || {
      multipleChoice: { total: 0, correct: 0, points: 0 },
      trueFalse: { total: 0, correct: 0, partial: 0, points: 0, details: {} },
      shortAnswer: { total: 0, correct: 0, points: 0 },
      totalScore: 0, percentage: 0
    },
    totalScore: data.totalScore || data.score || 0,
    percentage: data.percentage || 0,
    score: data.totalScore || data.score || 0,
    correctCount: data.correctCount || 0,
    wrongCount: data.wrongCount || 0,
    totalQuestions: data.totalQuestions || 0,
    tabSwitchCount: data.tabSwitchCount || 0,
    tabSwitchWarnings: (data.tabSwitchWarnings || []).map((t: any) =>
      t instanceof Timestamp ? t.toDate() : new Date(t)
    ),
    autoSubmitted: data.autoSubmitted || false,
    startedAt: toDate(data.startedAt),
    submittedAt: toDate(data.submittedAt),
    duration: data.duration || 0,
    status: data.status || 'in_progress'
  };
};

export const getSubmission = async (submissionId: string): Promise<Submission | null> => {
  const submissionRef = doc(db, 'submissions', submissionId);
  const submissionSnap = await getDoc(submissionRef);
  if (submissionSnap.exists()) return parseSubmissionData(submissionSnap.id, submissionSnap.data());
  return null;
};

export const getSubmissionsByRoom = async (roomId: string): Promise<Submission[]> => {
  const q = query(collection(db, 'submissions'), where('roomId', '==', roomId));
  const snapshot = await getDocs(q);
  const submissions = snapshot.docs.map((docSnap) => parseSubmissionData(docSnap.id, docSnap.data()));
  return submissions.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
};

export const getStudentSubmission = async (roomId: string, studentId: string): Promise<Submission | null> => {
  const q = query(
    collection(db, 'submissions'),
    where('roomId', '==', roomId),
    where('student.id', '==', studentId)
  );
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  return parseSubmissionData(snapshot.docs[0].id, snapshot.docs[0].data());
};

export const getSubmissionsByStudent = async (studentId: string): Promise<Submission[]> => {
  const q = query(collection(db, 'submissions'), where('student.id', '==', studentId));
  const snapshot = await getDocs(q);
  const submissions = snapshot.docs.map((docSnap) => parseSubmissionData(docSnap.id, docSnap.data()));
  return submissions
    .filter(s => s.status === 'submitted')
    .sort((a, b) => (b.submittedAt?.getTime() || 0) - (a.submittedAt?.getTime() || 0));
};

export const getRoomsForStudent = async (classIds: string[]): Promise<Room[]> => {
  if (!classIds || classIds.length === 0) return [];
  const roomsMap = new Map<string, Room>();
  for (const classId of classIds) {
    try {
      const q = query(
        collection(db, 'rooms'),
        where('classId', '==', classId),
        where('status', 'in', ['active', 'waiting'])
      );
      const snapshot = await getDocs(q);
      snapshot.docs.forEach(docSnap => {
        const room = parseRoomData(docSnap.id, docSnap.data());
        roomsMap.set(room.id, room);
      });
    } catch (err) {
      console.warn(`getRoomsForStudent: lỗi khi truy vấn classId=${classId}`, err);
    }
  }
  const rooms = Array.from(roomsMap.values());
  const now = Date.now();
  const filtered = rooms.filter(room => {
    if (room.closesAt && now >= new Date(room.closesAt).getTime()) return false;
    return true;
  });
  return filtered.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
};

export const subscribeToSubmissions = (roomId: string, callback: (submissions: Submission[]) => void) => {
  const q = query(collection(db, 'submissions'), where('roomId', '==', roomId));
  return onSnapshot(q, (snapshot) => {
    const submissions = snapshot.docs.map((docSnap) => parseSubmissionData(docSnap.id, docSnap.data()));
    submissions.sort((a, b) => {
      if ((b.totalScore || 0) !== (a.totalScore || 0)) return (b.totalScore || 0) - (a.totalScore || 0);
      return (b.submittedAt?.getTime() || 0) - (a.submittedAt?.getTime() || 0);
    });
    callback(submissions);
  });
};

// ============ EXAM FUNCTIONS ============

// ✅ CẢI TIẾN: Hỗ trợ lưu PDF lên Google Drive thay vì Firestore chunks
export const createExam = async (examData: Omit<Exam, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
  // Tách các field PDF ra trước khi sanitize
  const {
    pdfBase64: pdfData,
    pdfDriveUrl,
    pdfDriveFileId,
    hasPdfSubcollection: _ignored,
    ...examDataNoPdf
  } = examData as any;

  // Bước 1: Tách base64 images ra subcollection
  const { strippedData, imageDocuments } = extractImagesFromExam(examDataNoPdf);

  // Bước 2: Sanitize
  let sanitized = sanitizeForFirestore(strippedData);

  // Bước 2.5: Nếu vẫn > 900KB → xóa triệt để mọi base64 còn sót
  let size = JSON.stringify(sanitized).length;
  if (size > 900000) {
    console.warn(`⚠️ Data vẫn lớn (${size} bytes), stripping ALL remaining base64...`);
    sanitized = removeAllBase64(sanitized);
    size = JSON.stringify(sanitized).length;
    console.log(`📦 After aggressive strip: ~${size} bytes`);
  }
  console.log(`📦 Exam size (final): ~${size} bytes`);
  console.log(`🖼️ Images to save separately: ${imageDocuments.length}`);

  // ✅ Ưu tiên Drive URL — không cần lưu PDF vào Firestore
  const hasDrivePdf = !!(pdfDriveUrl && pdfDriveFileId);
  const hasChunkPdf = !hasDrivePdf && !!(pdfData && pdfData.length > 0);

  // Bước 3: Lưu document chính
  const examRef = await addDoc(collection(db, 'exams'), {
    ...sanitized,
    ...(hasDrivePdf && { pdfDriveUrl, pdfDriveFileId }),
    hasImageSubcollection: imageDocuments.length > 0,
    hasPdfSubcollection: hasChunkPdf,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Bước 3.5: Fallback — lưu PDF base64 vào subcollection (đề cũ không dùng Drive)
  if (hasChunkPdf) {
    try {
      await savePDFToSubcollection(examRef.id, pdfData);
    } catch (err) {
      console.error('savePDFToSubcollection failed (exam still created):', err);
    }
  }

  // Bước 4: Lưu images vào subcollection
  if (imageDocuments.length > 0) {
    console.log(`🖼️ Saving ${imageDocuments.length} images to subcollection...`);
    const CHUNK_SIZE = 800000;

    for (const imgDoc of imageDocuments) {
      const base64 = imgDoc.base64 || '';
      if (base64.length > CHUNK_SIZE) {
        const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);
        console.log(`🖼️ Image ${imgDoc.id} (q${imgDoc.questionNumber}): ${base64.length} chars → ${totalChunks} chunks`);
        for (let i = 0; i < totalChunks; i++) {
          const chunk = base64.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          const chunkDoc = sanitizeForFirestore({
            questionNumber: imgDoc.questionNumber,
            imageIndex: imgDoc.imageIndex,
            id: imgDoc.id,
            filename: imgDoc.filename,
            contentType: imgDoc.contentType,
            base64: chunk,
            chunkIndex: i,
            totalChunks
          });
          if (chunkDoc) await addDoc(collection(db, 'exams', examRef.id, 'images'), chunkDoc);
        }
      } else {
        const imgData = sanitizeForFirestore({ ...imgDoc, chunkIndex: 0, totalChunks: 1 });
        if (imgData) await addDoc(collection(db, 'exams', examRef.id, 'images'), imgData);
      }
    }
    console.log(`✅ All images saved to exams/${examRef.id}/images`);
  }

  return examRef.id;
};

// ✅ CẢI TIẾN: Đọc thêm pdfDriveUrl/pdfDriveFileId, bỏ qua load base64 nếu có Drive URL
export const getExam = async (examId: string): Promise<Exam | null> => {
  const examRef = doc(db, 'exams', examId);
  const examSnap = await getDoc(examRef);
  if (!examSnap.exists()) return null;

  let data = examSnap.data();

  // Load images subcollection nếu có
  if (data.hasImageSubcollection) {
    try {
      const imagesSnap = await getDocs(collection(db, 'exams', examId, 'images'));
      const imageDocs = imagesSnap.docs.map((d) => d.data());
      if (imageDocs.length > 0) {
        data = mergeImagesIntoExam(data, imageDocs);
        console.log(`🖼️ Loaded ${imageDocs.length} images from subcollection for exam ${examId}`);
      }
    } catch (err) {
      console.warn('Failed to load images subcollection:', err);
    }
  }

  // ✅ Ưu tiên Drive URL — không cần load base64 nếu có Drive
  let pdfBase64: string | undefined;
  if (!data.pdfDriveUrl && data.hasPdfSubcollection) {
    try {
      pdfBase64 = await loadPDFFromSubcollection(examId);
      if (pdfBase64) {
        console.log(`📄 Loaded PDF from subcollection for exam ${examId} (${pdfBase64.length} chars)`);
      }
    } catch (err) {
      console.warn('Failed to load PDF subcollection:', err);
    }
  }

  return {
    id: examSnap.id,
    title: data.title || '',
    description: data.description,
    timeLimit: data.timeLimit || 45,
    questions: data.questions || [],
    sections: data.sections || [],
    answers: data.answers || {},
    images: data.images,
    createdBy: data.createdBy || '',
    pointsConfig: data.pointsConfig,
    // ✅ Drive fields
    pdfDriveUrl: data.pdfDriveUrl,
    pdfDriveFileId: data.pdfDriveFileId,
    // Backward compat
    hasPdfSubcollection: data.hasPdfSubcollection,
    pdfBase64,
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
};

export const getExamsByTeacher = async (teacherId: string): Promise<Exam[]> => {
  const q = query(collection(db, 'exams'), where('createdBy', '==', teacherId));
  const snapshot = await getDocs(q);
  const exams = snapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      title: data.title || '',
      description: data.description,
      timeLimit: data.timeLimit || 45,
      questions: data.questions || [],
      sections: data.sections || [],
      answers: data.answers || {},
      images: data.images,
      createdBy: data.createdBy || '',
      pointsConfig: data.pointsConfig,
      // ✅ Drive fields
      pdfDriveUrl: data.pdfDriveUrl,
      pdfDriveFileId: data.pdfDriveFileId,
      hasPdfSubcollection: data.hasPdfSubcollection,
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt),
    };
  });
  exams.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  return exams;
};

// ✅ CẢI TIẾN: Xoá cả file Drive nếu có
export const deleteExam = async (examId: string): Promise<void> => {
  // Lấy Drive file ID trước khi xoá document
  let driveFileId: string | undefined;
  try {
    const snap = await getDoc(doc(db, 'exams', examId));
    if (snap.exists()) driveFileId = snap.data().pdfDriveFileId;
  } catch (_) { /* bỏ qua */ }

  // Xoá subcollection PDF (backward compat)
  await deletePDFSubcollection(examId);

  // Xoá subcollection images
  try {
    const imagesSnap = await getDocs(collection(db, 'exams', examId, 'images'));
    if (!imagesSnap.empty) {
      const batch = writeBatch(db);
      imagesSnap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      console.log(`🗑️ Deleted ${imagesSnap.size} images from subcollection`);
    }
  } catch (err) {
    console.warn('Failed to delete images subcollection:', err);
  }

  // Xoá document chính
  await deleteDoc(doc(db, 'exams', examId));

  // ✅ Xoá file Drive nếu có (dùng import động để tránh circular dep)
  if (driveFileId) {
    try {
      const { deletePDFFromDrive } = await import('./googleDriveService');
      await deletePDFFromDrive(driveFileId);
      console.log(`🗑️ Deleted PDF from Google Drive: ${driveFileId}`);
    } catch (err) {
      console.warn('deletePDFFromDrive error (bỏ qua):', err);
    }
  }
};

// ============ ROOM FUNCTIONS ============

const generateRoomCode = (): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

const isRoomCodeUnique = async (code: string): Promise<boolean> => {
  const q = query(collection(db, 'rooms'), where('code', '==', code));
  const snapshot = await getDocs(q);
  return snapshot.empty;
};

export const createRoom = async (roomData: {
  examId: string;
  examTitle: string;
  teacherId: string;
  teacherName: string;
  timeLimit: number;
  classId?: string;
  className?: string;
  opensAt?: Date | null;
  closesAt?: Date | null;
  settings?: {
    allowLateJoin?: boolean;
    showResultAfterSubmit?: boolean;
    shuffleQuestions?: boolean;
    maxAttempts?: number;
    allowAnonymous?: boolean;
    showCorrectAnswers?: boolean;
    showExplanations?: boolean;
  };
}): Promise<Room> => {
  let code = generateRoomCode();
  let attempts = 0;
  while (!(await isRoomCodeUnique(code)) && attempts < 10) {
    code = generateRoomCode();
    attempts++;
  }

  const settings = {
    allowLateJoin: roomData.settings?.allowLateJoin ?? true,
    showResultAfterSubmit: roomData.settings?.showResultAfterSubmit ?? true,
    shuffleQuestions: roomData.settings?.shuffleQuestions ?? false,
    maxAttempts: roomData.settings?.maxAttempts ?? 1,
    allowAnonymous: roomData.settings?.allowAnonymous ?? false,
    showCorrectAnswers: roomData.settings?.showCorrectAnswers ?? true,
    showExplanations: roomData.settings?.showExplanations ?? true
  };

  const baseRoom = {
    code,
    examId: roomData.examId,
    examTitle: roomData.examTitle,
    teacherId: roomData.teacherId,
    teacherName: roomData.teacherName,
    status: 'waiting' as const,
    timeLimit: roomData.timeLimit,
    opensAt: roomData.opensAt ?? undefined,
    closesAt: roomData.closesAt ?? undefined,
    settings,
    allowLateJoin: settings.allowLateJoin,
    showResultAfterSubmit: settings.showResultAfterSubmit,
    shuffleQuestions: settings.shuffleQuestions,
    maxAttempts: settings.maxAttempts,
    allowAnonymous: settings.allowAnonymous,
    totalStudents: 0,
    submittedCount: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const room: Omit<Room, 'id'> = {
    ...baseRoom,
    ...(roomData.classId && { classId: roomData.classId }),
    ...(roomData.className && { className: roomData.className })
  };

  const firestoreData: any = { ...room, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  Object.keys(firestoreData).forEach((key) => {
    if (firestoreData[key] === undefined) delete firestoreData[key];
  });

  const roomRef = await addDoc(collection(db, 'rooms'), firestoreData);
  return { id: roomRef.id, ...room };
};

const parseRoomData = (id: string, data: DocumentData): Room => {
  const settings = data.settings || {};
  return {
    id,
    code: data.code || '',
    examId: data.examId || '',
    examTitle: data.examTitle || '',
    teacherId: data.teacherId || '',
    teacherName: data.teacherName || '',
    classId: data.classId,
    className: data.className,
    status: data.status || 'waiting',
    startTime: toDate(data.startTime),
    endTime: toDate(data.endTime),
    timeLimit: data.timeLimit || 45,
    settings: {
      allowLateJoin: settings.allowLateJoin ?? data.allowLateJoin ?? true,
      showResultAfterSubmit: settings.showResultAfterSubmit ?? data.showResultAfterSubmit ?? true,
      shuffleQuestions: settings.shuffleQuestions ?? data.shuffleQuestions ?? false,
      maxAttempts: settings.maxAttempts ?? data.maxAttempts ?? 1,
      allowAnonymous: settings.allowAnonymous ?? data.allowAnonymous ?? false,
      showCorrectAnswers: settings.showCorrectAnswers ?? true,
      showExplanations: settings.showExplanations ?? true
    },
    allowLateJoin: settings.allowLateJoin ?? data.allowLateJoin ?? true,
    showResultAfterSubmit: settings.showResultAfterSubmit ?? data.showResultAfterSubmit ?? true,
    shuffleQuestions: settings.shuffleQuestions ?? data.shuffleQuestions ?? false,
    maxAttempts: settings.maxAttempts ?? data.maxAttempts ?? 1,
    allowAnonymous: settings.allowAnonymous ?? data.allowAnonymous ?? false,
    totalStudents: data.totalStudents || 0,
    submittedCount: data.submittedCount || 0,
    opensAt: toDate(data.opensAt),
    closesAt: toDate(data.closesAt),
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt)
  };
};

export const getRoomByCode = async (code: string): Promise<Room | null> => {
  const q = query(collection(db, 'rooms'), where('code', '==', code.toUpperCase()));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  return parseRoomData(snapshot.docs[0].id, snapshot.docs[0].data());
};

export const getRoom = async (roomId: string): Promise<Room | null> => {
  const roomRef = doc(db, 'rooms', roomId);
  const roomSnap = await getDoc(roomRef);
  if (roomSnap.exists()) return parseRoomData(roomSnap.id, roomSnap.data());
  return null;
};

export const getRoomsByTeacher = async (teacherId: string): Promise<Room[]> => {
  const q = query(collection(db, 'rooms'), where('teacherId', '==', teacherId));
  const snapshot = await getDocs(q);
  const rooms = snapshot.docs.map((docSnap) => parseRoomData(docSnap.id, docSnap.data()));
  rooms.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  return rooms;
};

export const updateRoomStatus = async (roomId: string, status: Room['status']): Promise<void> => {
  const roomRef = doc(db, 'rooms', roomId);
  const updateData: Record<string, unknown> = { status, updatedAt: serverTimestamp() };
  if (status === 'active') updateData.startTime = serverTimestamp();
  else if (status === 'closed') updateData.endTime = serverTimestamp();
  await updateDoc(roomRef, updateData);
};

export const deleteRoom = async (roomId: string): Promise<void> => {
  const q = query(collection(db, 'submissions'), where('roomId', '==', roomId));
  const snapshot = await getDocs(q);
  await Promise.all(snapshot.docs.map((docSnap) => deleteDoc(docSnap.ref)));
  await deleteDoc(doc(db, 'rooms', roomId));
};

export const subscribeToRoom = (roomId: string, callback: (room: Room | null) => void) => {
  const roomRef = doc(db, 'rooms', roomId);
  return onSnapshot(roomRef, (docSnap) => {
    if (docSnap.exists()) callback(parseRoomData(docSnap.id, docSnap.data()));
    else callback(null);
  });
};

// ============ USER MANAGEMENT (Admin) ============

export const getAllUsers = async (): Promise<User[]> => {
  const snapshot = await getDocs(collection(db, 'users'));
  return snapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      name: data.name || '',
      email: data.email,
      avatar: data.avatar,
      role: data.role || Role.TEACHER,
      isApproved: data.isApproved ?? false,
      createdAt: toDate(data.createdAt),
      classIds: data.classIds || []
    };
  });
};

export const getPendingUsers = async (): Promise<User[]> => {
  const q = query(collection(db, 'users'), where('isApproved', '==', false));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      name: data.name || '',
      email: data.email,
      avatar: data.avatar,
      role: data.role || Role.TEACHER,
      isApproved: false,
      createdAt: toDate(data.createdAt),
      classIds: data.classIds || []
    };
  });
};

export const approveUser = async (userId: string): Promise<void> => {
  await updateDoc(doc(db, 'users', userId), { isApproved: true });
};

export const rejectUser = async (userId: string): Promise<void> => {
  await deleteDoc(doc(db, 'users', userId));
};

export const updateUserRole = async (userId: string, role: Role): Promise<void> => {
  await updateDoc(doc(db, 'users', userId), { role });
};

export const updateSubmission = async (submissionId: string, data: Partial<Submission>): Promise<void> => {
  await updateDoc(doc(db, 'submissions', submissionId), data as Record<string, unknown>);
};
