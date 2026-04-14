import multer from 'multer';

const ALLOWED_MIMETYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'audio/mpga',
  'audio/mp3',
];

const ALLOWED_EXTENSIONS = /\.(mp3|wav|m4a|webm|mp4|mpeg|mpga)$/i;

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 150 * 1024 * 1024,
  },
  fileFilter(req, file, cb) {
    const extOk = ALLOWED_EXTENSIONS.test(file.originalname);
    const mimeOk = ALLOWED_MIMETYPES.includes(file.mimetype);
    if (extOk || mimeOk) {
      cb(null, true);
    } else {
      cb(new Error('지원하지 않는 파일 형식입니다: ' + file.originalname));
    }
  },
});

export default upload.single('audio');
