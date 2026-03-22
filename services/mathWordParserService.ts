// services/mathWordParserService.ts
import JSZip from 'jszip';
import { ExamData, Question, QuestionOption, ImageData } from '../types';

/**
 * ============================================================
 * MATH WORD PARSER SERVICE - VERSION 8 (OMML + MULTILINE OPTIONS + UNDERLINE)
 *
 * ✅ FIXES:
 * 1) Không “cụt” công thức: đọc thêm OMML equation text (m:t) + w:br line breaks
 * 2) MathJax không “cụt” hệ: align/align* -> aligned khi nằm trong $...$
 * 3) Option/statement bị xuống dòng/paragraph: tự động ghép tiếp vào option/statement trước
 * 4) Underline detection: nếu cả option/statement được gạch chân => coi là đáp án/ý đúng
 * ============================================================
 */

// Types
type QuestionType = 'multiple_choice' | 'true_false' | 'short_answer' | 'writing' | 'unknown';

interface ParsedQuestion {
  number: number;
  globalIndex: number;
  part: number;
  type: QuestionType;
  text: string;
  options: QuestionOption[];
  correctAnswer: string | null;
  solution: string;
  images: ImageData[];
}

// Underline tracking
interface ParagraphData {
  text: string;
  imageRIds: string[];
  hasUnderline: boolean;
  underlinedSegments: string[];
}

// ============================================================
// TEXT NORMALIZATION
// ============================================================

function normalizeVietnamese(text: string): string {
  if (!text) return '';
  return text.normalize('NFC');
}

/**
 * Normalize latex to be safer for MathJax rendering.
 * - \[...\] => $$...$$
 * - \(...\) => $...$
 * - align/align* => aligned (safe inside $...$)
 * - keep newlines; only compress spaces/tabs
 */
function normalizeLatex(text: string): string {
  if (!text) return '';

  let s = text;

  // Convert \[...\] → $$...$$
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$1$$$$');

  // Convert \(...\) → $...$
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');

  // align -> aligned (MathJax safe inside $...$)
  s = s.replace(/\\begin\{align\*?\}/g, '\\begin{aligned}');
  s = s.replace(/\\end\{align\*?\}/g, '\\end{aligned}');

  // Fix multiple consecutive $ signs
  s = s.replace(/\${3,}/g, '$$');

  // Compress spaces/tabs but keep newlines
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

/**
 * Escape HTML but preserve LaTeX blocks ($...$ and $$...$$).
 * This avoids breaking MathJax while keeping safe HTML output.
 */
function escapeHtmlPreserveLaTeX(text: string): string {
  if (!text) return '';

  const latexBlocks: string[] = [];

  const protectLatex = (match: string): string => {
    latexBlocks.push(match);
    return `__LATEX_BLOCK_${latexBlocks.length - 1}__`;
  };

  // protect $$...$$ then $...$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, protectLatex);
  text = text.replace(/\$(?!\$)([\s\S]*?)\$(?!\$)/g, protectLatex);

  text = text.replace(/&/g, '&amp;');
  text = text.replace(/</g, '&lt;');
  text = text.replace(/>/g, '&gt;');

  for (let i = 0; i < latexBlocks.length; i++) {
    text = text.replace(`__LATEX_BLOCK_${i}__`, latexBlocks[i]);
  }

  return text;
}

// ============================================================
// MAIN EXPORT
// ============================================================

export const parseWordToExam = async (file: File): Promise<ExamData> => {
  console.log('📄 Parsing Word file:', file.name);

  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 1) Extract images
  const { images, imageRelMap } = await extractImages(zip);
  console.log('🖼️ Extracted images:', images.length);

  // 2) Parse document.xml
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('Không tìm thấy document.xml trong file Word');

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(documentXml, 'application/xml');

  // 3) Extract paragraphs (text + images + underline) with OMML support
  const paragraphs = extractParagraphsWithUnderline(xmlDoc, imageRelMap);
  console.log('📝 Total paragraphs:', paragraphs.length);

  // 4) Parse questions
  const examData = parseAllQuestions(paragraphs, images);

  // 5) Metadata
  examData.title = file.name.replace(/\.docx$/i, '');
  examData.images = images;

  console.log('✅ Parsed questions:', examData.questions.length);
  console.log('📊 Sections:', examData.sections.length);

  return examData;
};

// ============================================================
// EXTRACT IMAGES
// ============================================================

async function extractImages(
  zip: JSZip
): Promise<{
  images: ImageData[];
  imageRelMap: Map<string, string>;
}> {
  const images: ImageData[] = [];
  const imageRelMap = new Map<string, string>();

  try {
    const relsContent = await zip.file('word/_rels/document.xml.rels')?.async('string');
    if (relsContent) {
      const relPattern = /Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = relPattern.exec(relsContent)) !== null) {
        const rId = match[1];
        const target = match[2];
        if (target.includes('media/')) {
          const filename = target.split('/').pop() || '';
          imageRelMap.set(rId, filename);
        }
      }
    }

    for (const [path, zipEntry] of Object.entries(zip.files)) {
      if (path.startsWith('word/media/') && !zipEntry.dir) {
        const filename = path.split('/').pop() || '';
        const data = await zipEntry.async('base64');

        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const contentTypes: { [key: string]: string } = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
          bmp: 'image/bmp',
          svg: 'image/svg+xml'
        };

        let rId = '';
        for (const [rid, fname] of imageRelMap.entries()) {
          if (fname === filename) {
            rId = rid;
            break;
          }
        }

        images.push({
          id: `img_${images.length}`,
          filename,
          base64: data,
          contentType: contentTypes[ext] || 'image/png',
          rId
        });
      }
    }
  } catch (err) {
    console.warn('⚠️ Error extracting images:', err);
  }

  return { images, imageRelMap };
}

// ============================================================
// EXTRACT PARAGRAPHS (TEXT + IMAGE + UNDERLINE) WITH OMML SUPPORT
// ============================================================

function extractParagraphsWithUnderline(xmlDoc: Document, _imageRelMap: Map<string, string>): ParagraphData[] {
  const paragraphs: ParagraphData[] = [];
  const pElements = xmlDoc.getElementsByTagName('w:p');

  for (let i = 0; i < pElements.length; i++) {
    const p = pElements[i];

    let text = '';
    const imageRIds: string[] = [];
    let hasUnderline = false;
    const underlinedSegments: string[] = [];

    const runs = p.getElementsByTagName('w:r');

    for (let j = 0; j < runs.length; j++) {
      const run = runs[j];

      // ---------- images ----------
      const blips = run.getElementsByTagName('a:blip');
      for (let k = 0; k < blips.length; k++) {
        const embed = blips[k].getAttribute('r:embed');
        if (embed) imageRIds.push(embed);
      }

      const vImageData = run.getElementsByTagName('v:imagedata');
      for (let k = 0; k < vImageData.length; k++) {
        const rid = vImageData[k].getAttribute('r:id') || vImageData[k].getAttribute('o:relid');
        if (rid) imageRIds.push(rid);
      }

      const drawings = run.getElementsByTagName('w:drawing');
      for (let k = 0; k < drawings.length; k++) {
        const innerBlips = drawings[k].getElementsByTagName('a:blip');
        for (let l = 0; l < innerBlips.length; l++) {
          const embed = innerBlips[l].getAttribute('r:embed');
          if (embed && !imageRIds.includes(embed)) imageRIds.push(embed);
        }
      }

      // ---------- underline detection ----------
      const rPr = run.getElementsByTagName('w:rPr')[0];
      const isUnderlined = rPr ? rPr.getElementsByTagName('w:u').length > 0 : false;

      // ---------- text extraction (FIX: add m:t + w:br) ----------
      let runText = '';

      // w:t
      const wTextNodes = run.getElementsByTagName('w:t');
      for (let k = 0; k < wTextNodes.length; k++) runText += wTextNodes[k].textContent || '';

      // ✅ OMML equation text: m:t
      const mTextNodes = run.getElementsByTagName('m:t');
      for (let k = 0; k < mTextNodes.length; k++) runText += mTextNodes[k].textContent || '';

      // optional: field instruction
      const instrNodes = run.getElementsByTagName('w:instrText');
      for (let k = 0; k < instrNodes.length; k++) runText += instrNodes[k].textContent || '';

      // ✅ line breaks inside paragraph
      const brs = run.getElementsByTagName('w:br');
      if (brs.length > 0) runText += '\n'.repeat(brs.length);

      if (isUnderlined && runText.trim()) {
        hasUnderline = true;
        underlinedSegments.push(runText.trim());
      }

      text += runText;
    }

    text = normalizeVietnamese(text.trim());
    text = normalizeLatex(text);

    // Markdown underline format: [X]{.underline}
    const markdownUnderlinePattern = /\[([A-Da-d])\]\{\.underline\}/g;
    let mdMatch: RegExpExecArray | null;
    while ((mdMatch = markdownUnderlinePattern.exec(text)) !== null) {
      hasUnderline = true;
      underlinedSegments.push(mdMatch[1]);
    }
    text = text.replace(/\[([A-Da-d])\]\{\.underline\}/g, '$1');

    // normalize whitespace around newlines
    text = text.replace(/[ \t]*\n[ \t]*/g, '\n').trim();

    if (text || imageRIds.length > 0) {
      paragraphs.push({ text, imageRIds, hasUnderline, underlinedSegments });
    }
  }

  return paragraphs;
}

// ============================================================
// PARSE ALL QUESTIONS
// ============================================================

function parseAllQuestions(paragraphs: ParagraphData[], images: ImageData[]): ExamData {
  const examData: ExamData = {
    title: '',
    timeLimit: 90,
    sections: [],
    questions: [],
    answers: {},
    images: []
  };

  const fullText = paragraphs.map((p) => p.text).join('\n');
  const sectionInfo = detectSections(fullText, paragraphs);
  console.log('📊 Section info:', sectionInfo);

  const part1Questions = parsePart1WithUnderline(paragraphs, sectionInfo.part1Start, sectionInfo.part2Start, images);
  const part2Questions = parsePart2(paragraphs, sectionInfo.part2Start, sectionInfo.part3Start, images);
  const part3Questions = parsePart3(paragraphs, sectionInfo.part3Start, paragraphs.length, images);

  console.log(
    `📊 Parsed: PHẦN 1=${part1Questions.length}, PHẦN 2=${part2Questions.length}, PHẦN 3=${part3Questions.length}`
  );

  let globalIndex = 0;

  // PHẦN 1
  if (part1Questions.length > 0) {
    const section1Questions: Question[] = [];
    for (const pq of part1Questions) {
      const q = convertToQuestion(pq, globalIndex++);
      section1Questions.push(q);
      examData.questions.push(q);
      if (q.correctAnswer) examData.answers[q.number] = q.correctAnswer;
    }

    examData.sections.push({
      name: 'PHẦN 1. Trắc nghiệm nhiều lựa chọn',
      description: 'Thí sinh chọn một phương án đúng A, B, C hoặc D',
      points: '',
      questions: section1Questions,
      sectionType: 'multiple_choice'
    });
  }

  // PHẦN 2
  if (part2Questions.length > 0) {
    const section2Questions: Question[] = [];
    for (const pq of part2Questions) {
      const q = convertToQuestion(pq, globalIndex++);
      section2Questions.push(q);
      examData.questions.push(q);
    }

    examData.sections.push({
      name: 'PHẦN 2. Trắc nghiệm đúng sai',
      description: 'Thí sinh chọn Đúng hoặc Sai cho mỗi ý a), b), c), d)',
      points: '',
      questions: section2Questions,
      sectionType: 'true_false'
    });
  }

  // PHẦN 3
  if (part3Questions.length > 0) {
    const section3Questions: Question[] = [];
    for (const pq of part3Questions) {
      const q = convertToQuestion(pq, globalIndex++);
      section3Questions.push(q);
      examData.questions.push(q);
      if (q.correctAnswer) examData.answers[q.number] = q.correctAnswer;
    }

    examData.sections.push({
      name: 'PHẦN 3. Trắc nghiệm trả lời ngắn',
      description: 'Thí sinh điền đáp án số vào ô trống',
      points: '',
      questions: section3Questions,
      sectionType: 'short_answer'
    });
  }

  return examData;
}

// ============================================================
// DETECT SECTIONS
// ============================================================

interface SectionInfo {
  part1Start: number;
  part2Start: number;
  part3Start: number;
}

function detectSections(_fullText: string, paragraphs: ParagraphData[]): SectionInfo {
  const info: SectionInfo = { part1Start: -1, part2Start: -1, part3Start: -1 };

  // ✅ FIX: Dùng \b (word boundary) thay vì [.\s] để khớp kể cả cuối dòng
  // "PHẦN I" / "PHẦN I." / "PHẦN I " / "PHẦN I\n" đều khớp
  const part1Patterns = [
    /PHẦN\s*1/i,
    /PHAN\s*1/i,
    /PHẦN\s+I\b/i,            // ✅ FIX: word boundary thay [.\s]
    /Phần\s*1/i,
    /I\.\s*TRẮC\s*NGHIỆM/i,
    /I\.\s*TRAC\s*NGHIEM/i
  ];

  const part2Patterns = [
    /PHẦN\s*2/i,
    /PHAN\s*2/i,
    /PHẦN\s+II\b/i,           // ✅ FIX: word boundary thay [.\s]
    /Phần\s*2/i,
    /II\.\s*ĐÚNG\s*SAI/i,
    /II\.\s*DUNG\s*SAI/i,
    /ĐÚNG\s*SAI/i,
    /DUNG\s*SAI/i
  ];

  const part3Patterns = [
    /PHẦN\s*3/i,
    /PHAN\s*3/i,
    /PHẦN\s+III\b/i,          // ✅ FIX: word boundary thay [.\s]
    /Phần\s*3/i,
    /III\.\s*TRẢ\s*LỜI/i,
    /III\.\s*TRA\s*LOI/i,
    /TRẢ\s*LỜI\s*NGẮN/i,
    /TRA\s*LOI\s*NGAN/i
  ];

  for (let i = 0; i < paragraphs.length; i++) {
    const text = paragraphs[i].text;

    if (info.part1Start === -1) {
      for (const pattern of part1Patterns) {
        if (pattern.test(text)) { info.part1Start = i; break; }
      }
    }

    if (info.part2Start === -1 && i > info.part1Start) {
      for (const pattern of part2Patterns) {
        if (pattern.test(text)) { info.part2Start = i; break; }
      }
    }

    if (info.part3Start === -1 && i > Math.max(info.part1Start, info.part2Start)) {
      for (const pattern of part3Patterns) {
        if (pattern.test(text)) { info.part3Start = i; break; }
      }
    }
  }

  if (info.part1Start === -1) info.part1Start = 0;
  if (info.part2Start === -1) info.part2Start = paragraphs.length;
  if (info.part3Start === -1) info.part3Start = paragraphs.length;

  return info;
}

// ============================================================
// PARSE PART 1: MULTIPLE CHOICE (WITH UNDERLINE + MULTILINE OPTIONS)
// ============================================================

function parsePart1WithUnderline(
  paragraphs: ParagraphData[],
  startIdx: number,
  endIdx: number,
  images: ImageData[]
): ParsedQuestion[] {
  if (startIdx < 0 || endIdx <= startIdx) return [];

  const questions: ParsedQuestion[] = [];
  let currentQ: ParsedQuestion | null = null;

  let collectingContent = false;
  let contentBuffer: string[] = [];
  let inSolution = false;
  let solutionBuffer: string[] = [];

  // underline letters seen in this question
  let currentQuestionUnderlinedLetters: string[] = [];

  // option multiline support
  let currentOptionIndex = -1;
  let startedOptions = false;

  const questionPattern = /^C(?:âu|au)\s*(\d+)\s*[.:]\s*(.*)/i;
  const optionPattern = /^\s*([A-D])\s*[.\)]\s*(.*)/i;
  const answerPattern = /Ch(?:ọn|on)\s*([A-D])/i;

  for (let i = startIdx; i < endIdx; i++) {
    const para = paragraphs[i];
    const text = para.text;
    const imageRIds = para.imageRIds;

    if (!text && imageRIds.length === 0) continue;

    // Skip section headers
    if (
      /PHẦN\s*\d/i.test(text) ||
      /PHAN\s*\d/i.test(text) ||
      /Trắc\s*nghiệm/i.test(text) ||
      /Trac\s*nghiem/i.test(text)
    ) {
      continue;
    }

    // New question
    const qMatch = text.match(questionPattern);
    if (qMatch) {
      // flush prev
      if (currentQ) {
        if (contentBuffer.length > 0 && !currentQ.text) currentQ.text = contentBuffer.join(' ').trim();
        if (solutionBuffer.length > 0) currentQ.solution = solutionBuffer.join(' ').trim();

        if (!currentQ.correctAnswer && currentQuestionUnderlinedLetters.length > 0) {
          const underlinedAnswer = currentQuestionUnderlinedLetters.find((l) => /^[A-D]$/i.test(l));
          if (underlinedAnswer) {
            currentQ.correctAnswer = underlinedAnswer.toUpperCase();
            console.log(`📝 Câu ${currentQ.number}: Đáp án từ underline = ${currentQ.correctAnswer}`);
          }
        }

        if (currentQ.text) questions.push(currentQ);
      }

      const qNum = parseInt(qMatch[1]);
      const restText = qMatch[2].trim();

      currentQ = {
        number: qNum,
        globalIndex: 0,
        part: 1,
        type: 'multiple_choice',
        text: '',
        options: [],
        correctAnswer: null,
        solution: '',
        images: []
      };

      collectingContent = true;
      inSolution = false;
      contentBuffer = restText ? [restText] : [];
      solutionBuffer = [];
      currentQuestionUnderlinedLetters = [];

      // reset option tracking
      currentOptionIndex = -1;
      startedOptions = false;

      // underline in question line
      if (para.hasUnderline) currentQuestionUnderlinedLetters.push(...para.underlinedSegments);

      if (imageRIds.length > 0) attachImages(currentQ, imageRIds, images);
      continue;
    }

    if (!currentQ) continue;

    // "Lời giải"
    if (/^L(?:ời|oi)\s*gi(?:ải|ai)/i.test(text)) {
      if (contentBuffer.length > 0 && !currentQ.text) {
        currentQ.text = contentBuffer.join(' ').trim();
        contentBuffer = [];
      }
      collectingContent = false;
      inSolution = true;
      solutionBuffer = [];
      continue;
    }

    // "Chọn X"
    const chonMatch = text.match(answerPattern);
    if (chonMatch) {
      currentQ.correctAnswer = chonMatch[1].toUpperCase();
      continue;
    }

    // Option line
    const optMatch = text.match(optionPattern);
    if (optMatch && collectingContent) {
      if (currentQ.options.length === 0 && contentBuffer.length > 0) {
        currentQ.text = contentBuffer.join(' ').trim();
        contentBuffer = [];
      }

      const letter = optMatch[1].toUpperCase();
      const optText = (optMatch[2] || '').trim();

      currentQ.options.push({ letter, text: optText });
      currentOptionIndex = currentQ.options.length - 1;
      startedOptions = true;

      // underline => correct
      if (para.hasUnderline) {
        currentQuestionUnderlinedLetters.push(letter);
        console.log(`🔍 Underline option ${letter} ở câu ${currentQ.number}`);
      }

      continue;
    }

    // Multiline option continuation
    if (collectingContent && startedOptions && currentOptionIndex >= 0 && text && !inSolution) {
      if (!/^H(?:ình|inh)\s*\d+/i.test(text)) {
        currentQ.options[currentOptionIndex].text = (currentQ.options[currentOptionIndex].text + ' ' + text).trim();
        if (para.hasUnderline) currentQuestionUnderlinedLetters.push(currentQ.options[currentOptionIndex].letter);
      }
      if (imageRIds.length > 0) attachImages(currentQ, imageRIds, images);
      continue;
    }

    // Collect question stem (only before options)
    if (collectingContent && text && !inSolution && !startedOptions) {
      if (/^H(?:ình|inh)\s*\d+/i.test(text)) {
        if (imageRIds.length > 0) attachImages(currentQ, imageRIds, images);
        continue;
      }
      contentBuffer.push(text);
      if (para.hasUnderline) currentQuestionUnderlinedLetters.push(...para.underlinedSegments);
    }

    // Collect solution
    if (inSolution && text) {
      if (!/^H(?:ình|inh)\s*\d+/i.test(text)) solutionBuffer.push(text);
    }

    if (imageRIds.length > 0 && !inSolution) attachImages(currentQ, imageRIds, images);
  }

  // flush last
  if (currentQ) {
    if (contentBuffer.length > 0 && !currentQ.text) currentQ.text = contentBuffer.join(' ').trim();
    if (solutionBuffer.length > 0) currentQ.solution = solutionBuffer.join(' ').trim();

    if (!currentQ.correctAnswer && currentQuestionUnderlinedLetters.length > 0) {
      const underlinedAnswer = currentQuestionUnderlinedLetters.find((l) => /^[A-D]$/i.test(l));
      if (underlinedAnswer) {
        currentQ.correctAnswer = underlinedAnswer.toUpperCase();
        console.log(`📝 Câu ${currentQ.number}: Đáp án từ underline = ${currentQ.correctAnswer}`);
      }
    }

    if (currentQ.text) questions.push(currentQ);
  }

  questions.sort((a, b) => a.number - b.number);
  return questions;
}

// ============================================================
// PARSE PART 2: TRUE/FALSE (WITH UNDERLINE + MULTILINE STATEMENTS)
// ============================================================

function parsePart2(paragraphs: ParagraphData[], startIdx: number, endIdx: number, images: ImageData[]): ParsedQuestion[] {
  if (startIdx < 0 || endIdx <= startIdx || startIdx >= paragraphs.length) return [];

  const questions: ParsedQuestion[] = [];
  let currentQ: ParsedQuestion | null = null;

  let collectingContent = false;
  let contentBuffer: string[] = [];
  let inSolution = false;
  let solutionBuffer: string[] = [];

  // underline => true statements
  let currentQuestionTrueStatements: Set<string> = new Set();

  // statement multiline support
  let currentStmtIndex = -1;
  let startedStatements = false;

  const questionPattern = /^C(?:âu|au)\s*(\d+)\s*[.:]\s*(.*)/i;
  const statementPattern = /^\s*([a-d])\s*[\)\.]\s*(.*)/i;

  for (let i = startIdx; i < endIdx; i++) {
    const para = paragraphs[i];
    const text = para.text;
    const imageRIds = para.imageRIds;

    if (!text && imageRIds.length === 0) continue;
    if (/PHẦN\s*\d/i.test(text) || /PHAN\s*\d/i.test(text)) continue;

    const qMatch = text.match(questionPattern);
    if (qMatch) {
      // flush prev
      if (currentQ) {
        if (contentBuffer.length > 0 && !currentQ.text) currentQ.text = contentBuffer.join(' ').trim();
        if (solutionBuffer.length > 0) currentQ.solution = solutionBuffer.join(' ').trim();

        if (!currentQ.correctAnswer && currentQuestionTrueStatements.size > 0) {
          const trueStmts = Array.from(currentQuestionTrueStatements).sort();
          currentQ.correctAnswer = trueStmts.join(',');
          console.log(`📝 Câu ${currentQ.number} (Đúng/Sai): underline = ${currentQ.correctAnswer}`);
        }

        if (currentQ.text) questions.push(currentQ);
      }

      const qNum = parseInt(qMatch[1]);
      const restText = qMatch[2].trim();

      currentQ = {
        number: qNum,
        globalIndex: 0,
        part: 2,
        type: 'true_false',
        text: '',
        options: [],
        correctAnswer: null,
        solution: '',
        images: []
      };

      collectingContent = true;
      inSolution = false;
      contentBuffer = restText ? [restText] : [];
      solutionBuffer = [];

      currentQuestionTrueStatements = new Set();
      currentStmtIndex = -1;
      startedStatements = false;

      if (imageRIds.length > 0) attachImages(currentQ, imageRIds, images);
      continue;
    }

    if (!currentQ) continue;

    if (/^L(?:ời|oi)\s*gi(?:ải|ai)/i.test(text)) {
      if (contentBuffer.length > 0 && !currentQ.text) {
        currentQ.text = contentBuffer.join(' ').trim();
        contentBuffer = [];
      }
      collectingContent = false;
      inSolution = true;
      solutionBuffer = [];
      continue;
    }

    const stmtMatch = text.match(statementPattern);
    if (stmtMatch && collectingContent) {
      if (currentQ.options.length === 0 && contentBuffer.length > 0) {
        currentQ.text = contentBuffer.join(' ').trim();
        contentBuffer = [];
      }

      const letter = stmtMatch[1].toLowerCase();
      const stmtText = (stmtMatch[2] || '').trim();

      currentQ.options.push({ letter, text: stmtText });
      currentStmtIndex = currentQ.options.length - 1;
      startedStatements = true;

      // underline => statement true
      if (para.hasUnderline) {
        currentQuestionTrueStatements.add(letter);
        console.log(`🔍 Underline statement ${letter} ở câu ${currentQ.number}`);
      }

      continue;
    }

    // Multiline statement continuation
    if (collectingContent && startedStatements && currentStmtIndex >= 0 && text && !inSolution) {
      if (!/^H(?:ình|inh)\s*\d+/i.test(text)) {
        currentQ.options[currentStmtIndex].text = (currentQ.options[currentStmtIndex].text + ' ' + text).trim();
        if (para.hasUnderline) {
          const letter = currentQ.options[currentStmtIndex].letter.toLowerCase();
          currentQuestionTrueStatements.add(letter);
        }
      }
      if (imageRIds.length > 0) attachImages(currentQ, imageRIds, images);
      continue;
    }

    // Collect stem only before statements
    if (collectingContent && text && !inSolution && !startedStatements) {
      if (/^H(?:ình|inh)\s*\d+/i.test(text)) {
        if (imageRIds.length > 0) attachImages(currentQ, imageRIds, images);
        continue;
      }
      contentBuffer.push(text);
    }

    // Collect solution
    if (inSolution && text) {
      if (!/^H(?:ình|inh)\s*\d+/i.test(text)) solutionBuffer.push(text);
    }

    if (imageRIds.length > 0 && !inSolution) attachImages(currentQ, imageRIds, images);
  }

  // flush last
  if (currentQ) {
    if (contentBuffer.length > 0 && !currentQ.text) currentQ.text = contentBuffer.join(' ').trim();
    if (solutionBuffer.length > 0) currentQ.solution = solutionBuffer.join(' ').trim();

    if (!currentQ.correctAnswer && currentQuestionTrueStatements.size > 0) {
      const trueStmts = Array.from(currentQuestionTrueStatements).sort();
      currentQ.correctAnswer = trueStmts.join(',');
      console.log(`📝 Câu ${currentQ.number} (Đúng/Sai): underline = ${currentQ.correctAnswer}`);
    }

    if (currentQ.text) questions.push(currentQ);
  }

  questions.sort((a, b) => a.number - b.number);
  return questions;
}

// ============================================================
// PARSE PART 3: SHORT ANSWER
// ============================================================

function parsePart3(paragraphs: ParagraphData[], startIdx: number, endIdx: number, images: ImageData[]): ParsedQuestion[] {
  if (startIdx < 0 || startIdx >= paragraphs.length) return [];

  const questions: ParsedQuestion[] = [];
  let currentQ: ParsedQuestion | null = null;
  let collectingContent = false;
  let contentBuffer: string[] = [];
  let solutionBuffer: string[] = [];

  const questionPattern = /^C(?:âu|au)\s*(\d+)\s*[.:]\s*(.*)/i;
  const answerPattern = /^[*\s]*(?:Đ|D)áp\s*(?:án|an)[:\s]*(.+)/i;

  for (let i = startIdx; i < endIdx; i++) {
    const para = paragraphs[i];
    const text = para.text;
    const imageRIds = para.imageRIds;

    if (!text && imageRIds.length === 0) continue;
    if (/PHẦN\s*\d/i.test(text) || /PHAN\s*\d/i.test(text)) continue;

    const qMatch = text.match(questionPattern);
    if (qMatch) {
      if (currentQ) {
        if (contentBuffer.length > 0) currentQ.text = contentBuffer.join(' ').trim();
        if (solutionBuffer.length > 0) currentQ.solution = solutionBuffer.join(' ').trim();
        if (currentQ.text) questions.push(currentQ);
      }

      const qNum = parseInt(qMatch[1]);
      const restText = qMatch[2].trim();

      currentQ = {
        number: qNum,
        globalIndex: 0,
        part: 3,
        type: 'short_answer',
        text: '',
        options: [],
        correctAnswer: null,
        solution: '',
        images: []
      };

      collectingContent = true;
      contentBuffer = restText ? [restText] : [];
      solutionBuffer = [];

      if (imageRIds.length > 0) attachImages(currentQ, imageRIds, images);
      continue;
    }

    if (!currentQ) continue;

    if (/^L(?:ời|oi)\s*gi(?:ải|ai)/i.test(text)) {
      if (contentBuffer.length > 0) {
        currentQ.text = contentBuffer.join(' ').trim();
        contentBuffer = [];
      }
      collectingContent = false;
      solutionBuffer = [];
      continue;
    }

    const ansMatch = text.match(answerPattern);
    if (ansMatch) {
      currentQ.correctAnswer = ansMatch[1].trim();
      continue;
    }

    if (collectingContent && text) {
      if (/^H(?:ình|inh)\s*\d+/i.test(text)) {
        if (imageRIds.length > 0) attachImages(currentQ, imageRIds, images);
        continue;
      }
      contentBuffer.push(text);
    }

    // collect solution text after "Lời giải"
    if (collectingContent === false && text && !/^C(?:âu|au)\s*\d+/.test(text)) {
      if (!/^H(?:ình|inh)\s*\d+/i.test(text) && !answerPattern.test(text)) {
        solutionBuffer.push(text);
      }
    }

    if (imageRIds.length > 0) attachImages(currentQ, imageRIds, images);
  }

  if (currentQ) {
    if (contentBuffer.length > 0) currentQ.text = contentBuffer.join(' ').trim();
    if (solutionBuffer.length > 0) currentQ.solution = solutionBuffer.join(' ').trim();
    if (currentQ.text) questions.push(currentQ);
  }

  questions.sort((a, b) => a.number - b.number);
  return questions;
}

// ============================================================
// HELPERS
// ============================================================

function attachImages(q: ParsedQuestion, rIds: string[], images: ImageData[]): void {
  for (const rId of rIds) {
    let img = images.find((i) => i.rId === rId);

    if (!img) {
      for (const image of images) {
        if (image.filename && rId.includes(image.filename)) {
          img = image;
          break;
        }
      }
    }

    if (img && !q.images.find((i) => i.id === img!.id)) {
      q.images.push(img);
    }
  }
}

function convertToQuestion(pq: ParsedQuestion, globalIndex: number): Question {
  const uniqueNumber = pq.part * 100 + pq.number;

  return {
    number: uniqueNumber,
    text: escapeHtmlPreserveLaTeX(pq.text),
    type: pq.type,
    options: pq.options.map((opt) => ({
      ...opt,
      text: escapeHtmlPreserveLaTeX(opt.text)
    })),
    correctAnswer: pq.correctAnswer,
    part: `PHẦN ${pq.part}`,
    images: pq.images,
    solution: pq.solution,
    section: {
      letter: String(pq.part),
      name: getPartName(pq.part),
      points: ''
    }
  };
}

function getPartName(part: number): string {
  switch (part) {
    case 1:
      return 'Trắc nghiệm nhiều lựa chọn';
    case 2:
      return 'Trắc nghiệm đúng sai';
    case 3:
      return 'Trắc nghiệm trả lời ngắn';
    default:
      return '';
  }
}

// ============================================================
// VALIDATE
// ============================================================

export const validateExamData = (data: ExamData): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  if (!data.questions || data.questions.length === 0) {
    errors.push('Không tìm thấy câu hỏi nào trong file');
  }

  let part1 = 0,
    part2 = 0,
    part3 = 0;
  let withAnswer = 0,
    withoutAnswer = 0;

  data.questions.forEach((q: Question) => {
    if (!q.text || !q.text.trim()) {
      errors.push(`Câu ${q.number}: Thiếu nội dung câu hỏi`);
    }

    const part = Math.floor(q.number / 100);
    if (part === 1) part1++;
    else if (part === 2) part2++;
    else if (part === 3) part3++;

    if (q.correctAnswer) withAnswer++;
    else withoutAnswer++;
  });

  console.log(`📊 Question count: PHẦN 1=${part1}, PHẦN 2=${part2}, PHẦN 3=${part3}`);
  console.log(`📊 Answers: Có đáp án=${withAnswer}, Chưa có=${withoutAnswer}`);

  return {
    valid: errors.length === 0,
    errors
  };
};

// ============================================================
// UTILITIES
// ============================================================

export function isWebCompatibleImage(contentType: string): boolean {
  const webTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
  return webTypes.includes(contentType);
}

export function getImageDataUrl(img: { base64: string; contentType: string }): string {
  if (!img.base64) return '';
  return `data:${img.contentType};base64,${img.base64}`;
}
