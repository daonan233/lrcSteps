# 声刻 KTV

Vue 3 + Node.js 的本地歌曲播放器。上传歌曲音频和普通日文 LRC 后，后台根据 LRC 行时间及人声估计逐字时间，播放器按音频时间扫色。可选上传罗马音 LRC，也可粘贴网易云音乐歌曲分享链接，自动获取日文及可用的罗马音 LRC，并对低置信度的行手动修正。

## 启动

需要 Node.js 22+ 和 Python 3.10+。首次安装前端依赖：

```powershell
npm install
```

安装音频校时依赖，建议使用独立 Python 虚拟环境：

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r worker\requirements.txt
.\.venv\Scripts\python -m pip install -r worker\requirements-separation.txt
$env:PYTHON_CMD = (Resolve-Path .\.venv\Scripts\python.exe).Path
```

`requirements-separation.txt` 为人声分离依赖。没有它时仍会尝试在原始歌曲上对齐，但复杂伴奏下质量较差。FFmpeg 可在系统 PATH 中提供；`imageio-ffmpeg` 也会随校时依赖安装。

```powershell
npm run dev
```

打开 `http://localhost:5173`。正式构建用 `npm run build`，然后 `npm start`，地址为 `http://localhost:3001`。歌曲信息与校时结果保存在 `data/songs.sqlite`，音频和模型缓存在 `data/`；这些文件不会提交到 Git。

上传页的“从网易云获取歌词”接受歌曲分享链接或纯歌曲 ID。点击“获取歌词”后，LRC 会填入下方上传表单，也可以分别下载。接口没有返回 `romalrc.lyric` 时仅填入日文 LRC，罗马音仍可手动上传；下载歌词功能依赖网易云音乐接口当前可访问且有对应歌词。

`examples/aaa-koito-to-amezora/` 提供一首完整示例歌曲的压缩音频、日文与罗马音 LRC，以及已保存的逐字校时数据。按该目录的 README 说明即可在页面中试用。

## 自动校时过程

1. 普通 LRC 给出每行歌词的搜索时间窗。
2. Demucs 分离人声（如果已安装），FFmpeg 转成 16 kHz 单声道音频。
3. Sudachi 解析汉字读音，`pykakasi` 转成罗马字；CTC 模型在该行的音频时间窗内做 Viterbi 强制对齐。
4. 将读音边界映射回歌词字符。上传的罗马音会独立对齐；无法对齐的行保留行内均分估算，并标出待检查。

默认模型是 [`NextFire/mms-300m-ForcedAligner-karaoke-ja-Latn`](https://huggingface.co/NextFire/mms-300m-ForcedAligner-karaoke-ja-Latn)。**首次校时会下载约 1.26 GB 的模型权重**，并需要联网。该模型权重采用 CC BY-NC-SA 4.0；有商业用途时请通过 `ALIGN_MODEL` 指向许可合适、且兼容 Latin CTC 字符表的模型。模型缓存位于 `data/models`，歌曲音频与歌词也保存在本机。

可选环境变量：`PYTHON_CMD` 指定 Python 可执行文件；`FFMPEG_PATH` 指定 FFmpeg；`ALIGN_MODEL` 指定模型；`ALIGN_CPU=1` 强制 CPU；`ALIGN_SKIP_SEPARATION=1` 跳过人声分离；`DATA_DIR` 指定数据目录；`HF_ENDPOINT` 指定可访问的模型下载站点；`PORT` 指定服务端口。

**精度说明：**自动校时是估计。拖长音、和声、伴奏残留以及汉字与读音不一一对应，都会影响逐字边界；页面的“调整”功能用于修正这些结果。播放器始终使用原歌曲音频，分离人声仅用于校时。

## 测试

```powershell
npm test
python -m unittest discover -s worker -p "test_*.py"
npm run build
```
