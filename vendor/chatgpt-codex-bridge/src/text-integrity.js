const QUESTION_MARK_ENCODING_ERROR =
  "文本编码异常：内容里出现大量问号，疑似中文已经在发送前损坏。请重新输入后再发送。";

export function looksLikeQuestionMarkEncodingLoss(value = "") {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }

  const nonSpaceText = text.replace(/\s/g, "");
  const questionMarks = (text.match(/\?/g) || []).length;
  const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
  const hasMeaningfulAscii = /[a-z0-9]/iu.test(text);
  const hasEnoughQuestionMarksToStandAlone = questionMarks >= 8;
  return (
    !hasCjk &&
    (hasMeaningfulAscii || hasEnoughQuestionMarksToStandAlone) &&
    /\?{3,}/.test(text) &&
    questionMarks >= 5 &&
    questionMarks / Math.max(nonSpaceText.length, 1) >= 0.35
  );
}

export function assertTextIntegrity(value = "") {
  if (looksLikeQuestionMarkEncodingLoss(value)) {
    const error = new Error(QUESTION_MARK_ENCODING_ERROR);
    error.code = "text_encoding_loss";
    throw error;
  }
}

export { QUESTION_MARK_ENCODING_ERROR };
