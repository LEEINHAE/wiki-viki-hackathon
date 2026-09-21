export const uploadAccept = '.docx,.pdf,.xlsx,.pptx';
export const uploadFormatMessage =
	'DOCX, 텍스트 기반 PDF, Excel(.xlsx), PowerPoint(.pptx) 파일을 선택해 주세요. 구형 .xls·.ppt는 .xlsx·.pptx로 저장한 뒤 올려 주세요.';
export const supportsUpload = (name) => /\.(docx|pdf|xlsx|pptx)$/i.test(name || '');
