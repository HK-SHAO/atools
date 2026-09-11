// 内核自带的基准：`moon bench --target wasm` 直接跑 wasm 产物本身。
// 它量的是「内核这段代码有多快」，不含 JS↔wasm 边界与宿主搬运；
// 与 TS 参照实现的对照见 app/lib/fft.test.ts 的等价门禁和 docs/algorithms.md 的微基准表。

///|
let bench_wins : FixedArray[Int] = [256, 512, 1024, 4096]

///|
/// 灌一组确定性伪随机输入。与 TS 侧基准用同一条 LCG，两边量的是同一件事（都含一次填数）。
fn bench_seed(win : Int, seed : Int) -> Unit {
  let mut s = seed
  for i = 0; i < win; i = i + 1 {
    s = (s * 1664525 + 1013904223) & 0x7FFFFFFF
    re.unsafe_set(i, s.to_double() / 2147483647.0 - 0.5)
    im.unsafe_set(i, 0.0)
  }
}

///|
test "bench 原地 FFT" (it : @bench.T) {
  for win in bench_wins {
    ignore(plan(win))
    it.bench(name="forward-\{win}", fn() {
      bench_seed(win, 0x9e3779b9 + win)
      forward()
      it.keep(re.unsafe_get(0))
    })
    it.bench(name="inverse-\{win}", fn() {
      bench_seed(win, 0x9e3779b9 + win)
      inverse()
      it.keep(re.unsafe_get(0))
    })
  }
}
