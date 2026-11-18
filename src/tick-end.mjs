/**
 * `tick_end` 补发 —— 26.1+ 服务端「每 tick 只许一个位置包」的硬校验，mineflayer 不补就会秒踢。
 *
 * 🔴 起因（2026-11-18 实机，Paper 26.3-244 + ViaBackwards 5.12.2）：
 *    进服成功、坐标也对，但 **1~2 秒后必被踢**，服务端只留一行
 *    `lost connection: Invalid move player packet received`（断开原因 `multiplayer.disconnect.invalid_player_movement`），
 *    日志里连 `moved too quickly` 都没有 —— 说明不是"走太快"，是**包本身没通过校验**。
 *
 *    从服务端字节码（`ServerGamePacketListenerImpl.handleMovePlayer`）里挖出来的判定是：
 *      if (packet.hasPosition()) {
 *        if (this.receivedPositionThisTick) disconnect("multiplayer.disconnect.invalid_player_movement");
 *        this.receivedPositionThisTick = true;
 *      }
 *    而 `receivedPositionThisTick` **只在 `handleClientTickEnd(ServerboundClientTickEndPacket)` 里清 0**。
 *    也就是说：客户端每 tick 必须发一个 `tick_end` 收尾，服务端才认为"上一 tick 结束了"。
 *
 *    实测坐实（本地 Paper 26.3，四种版本声明全试）：
 *      - `version:false / 26.1 / 1.21.11 / 1.21.4` —— **全部**在第 2 个位置包后被踢（连 ViaBackwards 支持最好的 1.21.4 也一样）；
 *      - 把第 2 个及以后的位置包全部拦掉 → **活满 10 秒**（证明触发点是"第二个位置包"）；
 *      - 在每个位置包后补发 `tick_end {}` → **活 14 秒、78 个位置包全收、真的往前走了 12.3 格**。
 *
 *    为什么装了 ViaBackwards 也没用：它只翻译客户端**已经会发**的包，不会替老客户端凭空造一个
 *    `tick_end`。真实 26.1.2 客户端自己会发（`ServerboundClientTickEndPacket` 在 26.1.2 里就有），
 *    所以人手玩没事、mineflayer 一进就踢 —— 差别不在协议版本，在**这一只手**。
 *
 * 为什么放这一层：`connection.mjs` 是全插件唯一 `mineflayer.createBot()` 的地方，
 *   和 `patchBlockAt()` 同一个理由 —— 一个坑只在一个地方堵。
 */

/** 带位置的移动包：服务端只对这两个置 `receivedPositionThisTick`。 */
const POSITION_PACKETS = new Set(['position', 'position_look'])

/**
 * 这个连接用的协议版本里有没有 `tick_end` 这个上行包？
 *
 * 🔴 必须"先查后发"：protodef 对未知包名**不报错**，会写出「id=0x00 + 空 body」，
 *    服务端把它当别的包去解 ⇒ 秒踢（同一个坑 2026-10 已经踩过一次，见 `core.mjs` 里 `player_input` 那段）。
 *    查的是 `bot.registry`（= mineflayer 实际拿到的 minecraft-data），不是硬编码版本号：
 *    `tick_end` 在 26.1 的协议表里是 `0x0d`，1.21.x 里没有 ⇒ 老服自动不发。
 */
function protocolHasTickEnd (b) {
  try {
    const mappings = b?.registry?.protocol?.play?.toServer?.types?.packet?.[1]?.[0]?.type?.[1]?.mappings
    return Boolean(mappings) && Object.values(mappings).includes('tick_end')
  } catch {
    return false
  }
}

/**
 * 给 bot 的出站包套一层"位置包后补 `tick_end`"。**幂等**：同一个 bot 套两次也只套一层。
 *
 * 不缓存 `protocolHasTickEnd()` 的结果：`createBot()` 返回时 `bot.registry` 还没挂上
 *（要等 login 之后），缓存早了会把它永久判成"没有这个包"，等于没修。
 *
 * @param {object} b mineflayer bot
 * @returns {object} 同一个 bot（方便链式）
 */
export function patchClientTickEnd (b) {
  if (!b || !b._client || typeof b._client.write !== 'function' || b.__wcTickEndPatched) return b
  const raw = b._client.write.bind(b._client)
  b._client.write = (name, params) => {
    const out = raw(name, params)
    if (POSITION_PACKETS.has(name) && protocolHasTickEnd(b)) {
      try { raw('tick_end', {}) } catch { /* 这个版本没有这个包：宁可少发，也不能发坏包 */ }
    }
    return out
  }
  b.__wcTickEndPatched = true
  return b
}

/** 自检用：判断这个 bot 是否已经套过（别拿私有字段到处摸）。 */
export const isTickEndPatched = (b) => Boolean(b && b.__wcTickEndPatched)
