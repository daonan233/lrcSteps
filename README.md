# 声刻 KTV

Vue 3 + Node.js 的本地歌曲播放器和 MV 字幕工具。上传歌曲音频和普通日文 LRC 后，后台根据 LRC 行时间及人声估计逐字时间，播放器按音频时间扫色。可选上传罗马音 LRC，也可粘贴网易云音乐歌曲分享链接，自动获取日文及可用的罗马音 LRC，并对低置信度的行手动修正。完成校时后，还可以上传自己的 MV，在视频上预览歌词并导出带字幕的 MP4 或 ASS 字幕。

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

## MV 歌词字幕

1. 在“歌曲与校时”中上传或导入歌曲，等自动校时完成，并用时间轴修正需要调整的逐字边界。
2. 切换到“MV 歌词字幕”，选择关联歌曲，上传 MP4、MOV、WebM 或 MKV 文件（最大 1 GB、最长 4 小时）。MV 保留在本机 `data/mv/uploads/`。
3. 播放 MV，点击“跳到首句”或拖动试听进度。可点击“自动估算偏移”比对歌曲与 MV 的音频，再用偏移滑轨对准人声。正偏移表示 MV 中的歌声出现得更晚；没有可用音轨或匹配把握不足时手动调整。
4. 选择“单句版”或“双句 KTV 版”。双句版左右两侧交替显示，当前句逐字扫色，下一句提前出现；每句都显示日文和已上传的罗马音。MV 开头第一句，以及歌曲中途两句之间至少有 8 秒空档时，开唱前最多 4 秒会在歌词上方出现三个灰色提示点，再从右向左逐个消失；较长间奏中的下一句会在开唱前约 3.5 秒出现，上一段唱完后会退场。左句与右句可分别调整横向位置、纵向位置和字号，也可以调整颜色及罗马音显示，播放 MV 即可实时预览。
5. 点击“保存同步和样式”后可先导出 30 秒预览，再导出完整 MP4，或下载对应版本的 ASS 字幕。两种版本的 MP4 分别保存和下载，不会互相覆盖；修改同步或样式后需要重新导出受影响的 MP4。

MP4 导出由服务端 FFmpeg 烧录字幕并保留 MV 原音轨；原始 MV 和生成文件都保存在本机 `data/mv/`。导出在后台执行，页面显示进度。为保证 MP4 导出可用，FFmpeg 需要带 `ass`/libass、`libx264` 和 `aac` 编码支持；可设置 `FFMPEG_PATH` 指向其可执行文件。通过 `worker/requirements.txt` 安装的 `imageio-ffmpeg` 在此 Windows 环境也可供项目使用。部分 MOV/MKV 编码可能无法由浏览器直接预览，但仍可尝试导出。ASS 的时间精度为百分之一秒，导出前建议试听确认。

网页预览和 MP4 导出使用项目内的 Noto Sans JP ExtraBold（日文）及 DM Sans Bold（罗马音）字体，授权文本位于 `assets/licenses/`。更新字幕样式或项目的渲染版本后，请重新导出 MP4；旧视频中的字幕不会自动改变。

## 自动校时过程

1. 普通 LRC 给出每行歌词的搜索时间窗。
2. Demucs 分离人声（如果已安装），FFmpeg 转成 16 kHz 单声道音频。
3. Sudachi 解析汉字读音，`pykakasi` 转成罗马字；CTC 模型在该行的音频时间窗内做 Viterbi 强制对齐。
4. 将读音边界映射回歌词字符。上传的罗马音会独立对齐；无法对齐的行保留行内均分估算，并标出待检查。

手动校对时切换到“罗马音”轨，可直接在输入框修改整句罗马音，也能边听边点选多余字符并点击“删除选中的罗马音”。文字修改会立即更新预览；字符数变化时会先在原句时间范围内临时均分，建议点击“本句重新校时”。删除按钮仍会衔接相邻字符的时间；之后也能用滑轨微调。“本句重新校时”固定在调整窗口底部，使用当前编辑后的罗马音及其首尾时间作为搜索范围。试听满意后再点“保存校时”。切换到日文轨可以只重算本句日文时间。取消窗口会放弃未保存的改动。已关联的 MV 会使用保存后的罗马音，之前导出的 MP4 需要重新生成。

默认模型是 [`NextFire/mms-300m-ForcedAligner-karaoke-ja-Latn`](https://huggingface.co/NextFire/mms-300m-ForcedAligner-karaoke-ja-Latn)。**首次校时会下载约 1.26 GB 的模型权重**，并需要联网；后续校时会优先使用 `data/models` 中的完整缓存，避免每次请求模型站点。该模型权重采用 CC BY-NC-SA 4.0；有商业用途时请通过 `ALIGN_MODEL` 指向许可合适、且兼容 Latin CTC 字符表的模型。歌曲音频与歌词也保存在本机。

可选环境变量：`PYTHON_CMD` 指定 Python 可执行文件；`FFMPEG_PATH` 指定 FFmpeg；`ALIGN_MODEL` 指定模型；`ALIGN_CPU=1` 强制 CPU；`ALIGN_SKIP_SEPARATION=1` 跳过人声分离；`DATA_DIR` 指定数据目录；`HF_ENDPOINT` 指定可访问的模型下载站点；`PORT` 指定服务端口。

**精度说明：**自动校时是估计。拖长音、和声、伴奏残留以及汉字与读音不一一对应，都会影响逐字边界；页面的“调整”功能用于修正这些结果。播放器始终使用原歌曲音频，分离人声仅用于校时。

## 测试

```powershell
npm test
python -m unittest discover -s worker -p "test_*.py"
npm run build
```
