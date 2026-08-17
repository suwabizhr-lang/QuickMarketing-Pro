// 業態マスタの初期投入。業態→必須ライセンス表示 のマスタ（設計書 §4 拡張の核）。
// 新業態は upsertBusinessType を1件足すだけで拡張可能。
import { upsertBusinessType, listBusinessTypes, ensureSchema } from './db.js';

const TYPES = [
  {
    id: 'kaitori',
    name: '買取店',
    required_licenses: [
      { key: 'antique_dealer', label: '古物商許可番号', pattern: '^\\d{12}$', hint: '12桁の数字' },
    ],
    cta_default_label: 'この店に今すぐ査定',
    form_kind_default: 'assessment',
  },
  // --- 将来の横展開例（コメントで雛形を残す） ---
  // { id:'realestate', name:'不動産', required_licenses:[{key:'takken', label:'宅地建物取引業免許番号'}], cta_default_label:'この物件を相談', form_kind_default:'consult' },
  // { id:'recruit', name:'人材紹介', required_licenses:[{key:'shokugyo', label:'有料職業紹介事業許可番号'}], cta_default_label:'転職を相談', form_kind_default:'consult' },
];

await ensureSchema();
for (const t of TYPES) await upsertBusinessType(t);
const list = await listBusinessTypes();
console.log('業態マスタ投入完了:', list.map(b => `${b.id}(${b.name})`).join(', '));
process.exit(0);
