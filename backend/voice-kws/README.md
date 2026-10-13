本目录模型来自 sherpa-onnx KWS 预训练模型 `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`
（官方 kws-models release，中英双语，一个模型同时识别中文 ppinyin 与英文 phone），
仅保留运行所需文件：encoder/joiner 用 int8、decoder 用 fp32（该模型 decoder 无 int8）。

keywords.txt 是运行时口令，唯一事实来源在 `backend/voice/voicePhraseCatalog.js`，
由 `buildKeywordsText()` 生成（本文件仅为离线核对用）。改口令请改那份目录。
