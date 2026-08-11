import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('network reachable from flutter test', () async {
    final client = HttpClient();
    final req = await client.openUrl(
        'POST', Uri.parse('https://api.undersilicon.cn/auth/anonymous'));
    req.headers.set('content-type', 'application/json');
    req.write('{}');
    final res = await req.close();
    final text = await res.transform(utf8.decoder).join();
    expect(res.statusCode, 200);
    expect(jsonDecode(text)['token'], isA<String>());
    client.close();
  });
}
