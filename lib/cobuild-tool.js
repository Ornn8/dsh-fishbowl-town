// 0.9.10 「一起盖楼」工具（fishbowl_town_build）：只挂在她和主人聊天的会话里；做事的是 cobuild.js。0.9.12 起也做一层室内（interior、floor）。
// 预览图两路给：结果里的 Markdown 图片行（DSH 的聊天按本机绝对路径显示，她原样放进给主人的话里，主人看得到），
// 她这一路的模型收图时，三张图也附在结果后面（DSH 附件服务），她自己看得到楼长什么样。
import { readFileSync } from 'node:fs'

export const BUILD_TOOL = 'fishbowl_town_build'
const DO = ['status', 'start', 'make', 'use', 'submit', 'confirm', 'stop']

const render = (_args, value) => (typeof value === 'string' ? [{ type: 'text', text: value }]
  : [{ type: 'text', text: String(value?.text ?? '') }, ...(Array.isArray(value?.images) ? value.images : []).map((attachment) => ({ type: 'image', attachment }))])

export const BUILD_DESCRIPTION = '「一起盖楼」：和主人一起在你岛上自己的地上盖楼（承包的楼、圈的地；田不行）。盖楼一定是你和主人一起：只在你和主人聊天的这里用，小镇的回合里不盖。'
  + '楼在主人电脑上的 Blender 里做：你只写配方（形状清单，纯数据），插件用 Blender 做成模型、出三张预览图（正面、斜 45°、俯视）、量尺寸，在本机先查一遍合不合这块地的规矩（地界、高度、面数、文件大小）。'
  + '楼长什么样、用哪些形状、什么材质和颜色、主人贴不贴自己的图，都由你们定，不限；只守地界和上限。' // 0.9.15：岛上 11-23「自由建模」
  + 'do="status"：看 Blender 装没装、正在盖的楼到哪一步了、交过的楼。'
  + 'do="start"：主人想盖（比如他说「我们盖个房子吧」），或者你提了、他答应了，就开始：lot 填你的地号（承包的楼也可以填楼号），idea 填你们想盖的（你自己的话），回给你这块地的建模说明。先问问主人想要什么样的。'
  + 'do="make"：照建模说明写好配方，recipe 填 {"shapes":[形状, …]}，插件做出一版：尺寸、哪里不合规矩、预览图。回来的预览图那几行原样放进你给主人的话里，他才看得到。他说要改，你改配方再 make（每次写整份配方）。'
  + '主人也可以用 Blender 打开插件给的 house.blend 亲手改，保存后插件会出新的一版、告诉你改了哪里；你再改配方时，他亲手改的部分会叠在你的新配方上留着。他说不要他改的了，make 时才写 over_owner=true。'
  + 'do="use"：换回以前的一版（version 填第几版）。'
  + 'do="submit"：主人看过预览、在这个聊天里亲口说了「交吧」以后才用：插件把模型交给岛上（带着他的原话），岛上当场报价（鲸币）。插件只认他自己打的字，他没说就交不了。'
  + 'do="confirm"：报价照实告诉主人了，他又亲口说了「盖吧」才用：这时才扣鲸币，楼上岛。不劝他花钱：鲸币不够就照实说。'
  + 'do="stop"：这栋楼先不盖了（文件留着）。'
  + '楼里的室内也这样和主人一起做（开店、开游戏、开场子、开工作站，楼里要有室内；住的家不用）：do="start" 再写 interior=true、floor 写第几层（不写 = 1），回给你这一层的室内说明；'
  + 'make 时 recipe 写室内配方 {"room":{…},"shapes":[家具, …],"lights":[…],"points":{…}}（家具可以一个都没有），插件做成这一层（一层一个 .glb，按外面的楼层叫：floor1.glb 就是 1 楼）。'
  + '室内跟着外面的楼走：几层就做几层，每层不比外面大，面数和文件按面积给。主人说「交吧」才交，岛上量好、拍好照才报价（几分钟，插件会告诉你），主人说「就这样」才 confirm、扣鲸币。'

export function createBuildTool({ cobuild = null, pictures = null, noteSession = () => {}, log = null }) {
  async function images(files, exec) {
    if (!pictures || !Array.isArray(files) || !files.length) return []
    try {
      if (!await pictures.canSee(exec)) return []
      return await pictures.admit(files.map((f) => ({ mediaType: 'image/png', data: readFileSync(f).toString('base64') })))
    } catch (error) {
      log?.info?.(`盖楼的预览图没附上（${String(error?.code || error?.message || error).slice(0, 80)}），只给 Markdown 图片行`)
      return []
    }
  }
  return {
    name: BUILD_TOOL,
    description: BUILD_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        do: { type: 'string', enum: DO, description: DO.join(' / ') },
        lot: { type: 'string', description: 'do=start：地号，比如 L-0107；承包的楼也可以填楼号，比如 B-0009' }, // 0.9.15：岛上 11-23 起认楼号
        idea: { type: 'string', description: 'do=start：你们想盖的，你自己的话（200 字以内）' },
        interior: { type: 'boolean', description: 'do=start：做楼里的室内（一层一份）才填 true' },
        floor: { type: 'integer', minimum: 1, description: 'do=start 且 interior=true：第几层（外面的第几楼；不写 = 1，按天租的铺位不用写）' },
        recipe: { description: 'do=make：配方，{"shapes":[形状, …]}，照建模说明写（JSON 对象，或者一段 JSON 文本）' },
        version: { type: 'integer', minimum: 1, description: 'do=use：换回第几版' },
        over_owner: { type: 'boolean', description: 'do=make：主人说不要他亲手改的那些了才填 true（他那一版一直留着）' },
      },
      required: ['do'],
    },
    output: {
      schema: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, images: { type: 'array', description: 'DSH 附件服务给的预览图（附在结果后面）' } } }] },
      render,
    },
    timeoutMs: 420_000,
    async execute(args, exec) {
      noteSession(exec)
      if (!cobuild) return { text: '这个插件版本还不能一起盖楼。' }
      const sid = String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
      const what = String(args?.do || '')
      let r
      try {
        if (what === 'status') r = await cobuild.status()
        else if (what === 'start') r = await cobuild.start({ lot: args?.lot, idea: args?.idea, interior: args?.interior === true, floor: args?.floor })
        else if (what === 'make') r = await cobuild.make({ recipe: args?.recipe, over_owner: args?.over_owner === true })
        else if (what === 'use') r = await cobuild.use({ version: args?.version })
        else if (what === 'submit') r = await cobuild.submit({ sid })
        else if (what === 'confirm') r = await cobuild.confirm({ sid })
        else if (what === 'stop') r = cobuild.stop()
        else return { text: `do 只能是 ${DO.join('、')}。` }
      } catch (error) {
        log?.warn?.('一起盖楼出错：', error?.message || error)
        return { text: `这一步出错了：${String(error?.message || error).slice(0, 120)}。` }
      }
      const shots = ['make', 'use', 'status'].includes(what) ? await images(r?.previews, exec) : []
      return { text: String(r?.text ?? r ?? ''), images: shots }
    },
  }
}
