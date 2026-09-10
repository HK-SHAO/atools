// `dist/` 直接作 Toy 包：zip 是「更新」语义，已存在的包不会自动剔除消失的文件，
// 所以先删旧包，且压的是目录里的**内容**（cd dist）而不是目录本身，index.html 落在包根。
const dist = `${import.meta.dir}/../dist`;
const zip = `${import.meta.dir}/../toy.zip`;

await Bun.$`rm -f ${zip}`;
await Bun.$`cd ${dist} && zip -qr ${zip} . -x '*.DS_Store'`;
console.log(`toy.zip  ${(Bun.file(zip).size / 1024 / 1024).toFixed(2)} MB  (index.html 在包根)`);
