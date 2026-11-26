// 0.9.12 说明跟上小镇 11-24 这一批（地租按成交价、汇率每天动、地价跟着成交价、面多文件大另收、开店要室内、探店、镇民四层、闲置收回）：
// 一份清单，查新手引导、README、工具说明里是岛上的原话，老说法（「每天交一点地租」这类）一处都没留。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILD_STEP, FX_RULE, LAND_RULE, RENT_RULE, guideText } from '../lib/guide.js'
import { GUIDE_POINTER, LOOK_TOPICS, createIsleTools, readOf } from '../lib/isle-tools.js'
import { BUILD_DESCRIPTION } from '../lib/cobuild-tool.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const [look, act] = createIsleTools({ live: () => null })
const SAID = { 新手引导: guideText(), README, 做一件事: act.description, 看岛上: look.description, 一起盖楼: BUILD_DESCRIPTION }

test('the island\'s own sentences: rent = 0.1% of the paid price (0.9.15: halved 11-23), the rate moves every day, land values follow nearby sales', () => {
  assert.equal(RENT_RULE, '每天地租 = 成交价的 0.1%（按地价算的更高就按地价）')                        // land.rent_note()
  assert.equal(FX_RULE, '汇率每天收盘调一次：当天买鲸币的多就涨、卖的多就跌，一天最多涨跌 5%；离起步价 ¥0.004 越远，往回拉得越多，最多偏 30%。')   // exchange.rule_text()
  assert.equal(LAND_RULE, '地价每天按附近 14 天的成交价调：成交价高于底价就涨，流拍、退地就跌，一天最多变 5%，最多到原价的 3 倍、最少 0.7 倍。')   // market NOTE
  for (const [where, text] of [['新手引导', guideText()], ['README', README]]) {
    for (const rule of [RENT_RULE, FX_RULE, LAND_RULE]) assert.ok(text.includes(rule), `${where} lacks 「${rule.slice(0, 12)}…」`)
    assert.match(text, /汇率每天收盘调一次/, where)
    assert.match(text, /成交价的 0\.1%/, where)
    assert.doesNotMatch(text, /0\.2%/, where)
  }
})

test('no old wording left: 「每天交一点地租」, 「一点物业」, 「退她七成」, the field rule 「也一样」, 「赚到的鲸币」, residents 「都住奶蛙公寓」, interiors 「这一版还做不了」', () => {
  for (const [where, text] of Object.entries(SAID)) {
    for (const old of ['每天交一点地租', '交一点地租', '一点物业', '退她七成', '田 7 天没种东西也一样', '赚到的鲸币', '都住奶蛙公寓', '现成的楼本来就有', '这一版还做不了']) {
      assert.ok(!text.includes(old), `${where} still says 「${old}」`)
    }
  }
})

test('idle land as the island runs it (idle.py): fee at 7 days, taken back at 14, she gets 70% of the sale; fields at 7; contracted buildings at 14 go to auction, 70% too', () => {
  const g = guideText()
  // 小镇 11-24「什么算在用」（店主「按你的倾向改」）：在做的事算在用；承包的楼空满 14 天收回挂拍，卖出给七成（不再是「承包费不退」）
  assert.match(g, /空地 7 天没楼、没在盖（和主人做着草稿、报价交上去 7 天内都算）、也没开店，地租翻倍（多的那份记成闲置费）；14 天镇上收回拿去拍卖，卖出后她得成交价的七成/)
  assert.match(g, /田 7 天没种着东西（熟了不收也算）就收回拍卖/)
  assert.match(g, /承包的楼空着 14 天（没开东西、没住、没整栋租出去，也没在做室内、重盖）也收回拿去拍卖，卖出后一样得七成/)
  assert.ok(!g.includes('承包费不退'))
  assert.ok(README.includes('卖出后她得成交价的七成'))
})

test('heavy models: the free allowance and the extra price and daily upkeep for faces and file size are stated; quotes are not cut', () => {
  assert.match(BUILD_STEP, /起步价里含一定的高度、体积、面数和文件大小，超出的另收；面数多、文件大的，每天的物业也跟着多/)
  assert.match(BUILD_STEP, /一项一项写着怎么算/)
  // 0.9.15：小镇 11-23 下午降价（价目表 building，和 build_guide 里的数一样）
  for (const w of ['起步 62.5 鲸币，含 20 米高、20000 立方米', '80000 面、2048 KB', '每一万面 50 鲸币', '每 MB 100 鲸币', '文件超出起步的每 MB 每天 2 鲸币', '面数超出起步的每一万面每天 1 鲸币']) {
    assert.ok(README.includes(w), w)
  }
})

test('shops need an inside: one plain line in the act pointer (still <= 120), the rules and prices in the README, and this version makes it with the owner', () => {
  assert.ok(GUIDE_POINTER.includes('开店前楼里要有室内'))
  assert.ok([...GUIDE_POINTER].length <= 120, `pointer is ${[...GUIDE_POINTER].length} chars`)
  assert.match(guideText(), /新开的店（游戏、场子、工作站也一样）楼里要先有室内/)
  assert.match(guideText(), /室内也是你和她一起做（见「在岛上盖楼」）/)
  for (const text of [BUILD_STEP, README]) assert.match(text, /开店、开游戏要楼里有室内：也是你们一起做，一层一份/)
  assert.match(README, /\*\*楼里的室内（0\.9\.12）\*\*/)
  assert.match(README, /你说「交吧」才交、说「就这样」才扣鲸币（怎么做见上面「楼里的室内」）/)
  assert.doesNotMatch(README + guideText(), /做室内要 0\.9\.12 以上|这一版（0\.9\.1[12]）还做不了/)
  for (const w of ['室内跟着外面的楼走：几层就做几层，每层不比外面大，面数和文件按面积给', '起步 20 鲸币 + 每平方米 0.2 鲸币', '物业每天每平方米 0.01 鲸币']) { // 0.9.15：小镇 11-23 下午降价
    assert.ok(README.includes(w), w)
  }
})

test('探店, the 镇民 topic, and island money is 鲸币 with no push to spend in what she reads', () => {
  assert.match(guideText(), /探店（门面、屋里、东西）：写不写随她，写了你在岛的页面「我的鱼」里看得到，每项能打 1–5 星/)
  assert.ok(LOOK_TOPICS.includes('镇民'))
  assert.equal(readOf({ topic: '镇民' }).topic, '镇民', 'not turned into 「我的」')
  assert.match(look.description, /镇民（四层镇民各要什么、住哪）/)
  for (const [where, text] of Object.entries(SAID)) {
    if (where === 'README') continue
    assert.doesNotMatch(text, /赚|划算|趁|该买|该卖|充值吧|去充值/, where)
  }
})
