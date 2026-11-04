// 与手机版固定口令一致；使用同一套中英 Zipformer KWS 的音素表。
const phrases = [
  ['choice_1', '第一个', '第一个', 'd ì y ī g è'],
  ['choice_2', '第二个', '第二个', 'd ì èr g è'],
  ['choice_3', '第三个', '第三个', 'd ì s ān g è'],
  ['choice_4', '第四个', '第四个', 'd ì s ì g è'],
  ['continue', '继续', '继续', 'j ì x ù'],
  ['unknown', '不认识', '不认识', 'b ù r èn sh i'],
  ['unknown', '不认识', '不认识', 'b ù r èn sh í'],
  ['unknown', '不认识', '不认识', 'b ù r èn sh ì'],
  ['choice_1', 'first', 'FIRST', 'F ER1 S T'],
  ['choice_2', 'second', 'SECOND', 'S EH1 K AH0 N D'],
  ['choice_3', 'third', 'THIRD', 'TH ER1 D'],
  ['choice_4', 'fourth', 'FOURTH', 'F AO1 R TH'],
  ['continue', 'continue', 'CONTINUE', 'K AH0 N T IH1 N Y UW0'],
  ['unknown', "don't know", 'DONT_KNOW', 'D OW1 N T N OW1'],
].map(([id, label, keyword, tokens]) => ({ id, label, keyword, tokens }));

module.exports = {
  phrases,
  buildKeywordsText: () => phrases.map(p => `${p.tokens} @${p.keyword}`).join('\n') + '\n',
  findPhraseByLabel: keyword => phrases.find(p => p.keyword === keyword) || null,
};
