import multer from 'multer';

const ALLOWED_MIMETYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/webm',
  'audio/mpga',
  'audio/mp3',
  'audio/ogg',
  'audio/flac',
  'video/mp4',
  'video/webm',
];

const ALLOWED_EXTENSIONS = /\.(mp3|wav|m4a|webm|mp4|mpeg|mpga|ogg|flac)$/i;

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 150 * 1024 * 1024,
  },
  fileFilter(req, file, cb) {
    // multer는 latin1으로 파일명을 읽으므로 한글 파일명 복원
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const extOk = ALLOWED_EXTENSIONS.test(file.originalname);
    const mimeOk = ALLOWED_MIMETYPES.includes(file.mimetype);
    if (extOk && mimeOk) {
      cb(null, true);
    } else {
      cb(new Error('지원하지 않는 파일 형식입니다.'));
    }
  },
});

export default upload.single('audio');
