// 배포를 기다리지 않고 수동으로 재수집을 요청할 때 쓴다: npm run seo:indexnow
import { submitPublicPagesToIndexNow } from '../src/services/indexnow.js';

const result = await submitPublicPagesToIndexNow();
process.exit(result.ok ? 0 : 1);
