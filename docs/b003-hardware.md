# B003 同一Macでの初回統合と実機接続

## 初回統合（機材なし）

同じMacで `Backend → 仮想シリアルのスレーブ → PythonのPTYマスター → B003Lock` を接続する。PTYはPythonが作成する。Node.js 18以上・npm・Python 3.9以上が必要。この構成では `socat`、`pyserial`、`nfcpy`、RC-S330、Atomは不要。

### 自動確認

リポジトリのルートで実行する。Backendの実際の `UsbSerialAdapter` と `SerialBridge` を起動し、隔離したインメモリDBと合成カードを使う。HTTP・LINE・実DBは使用しない。

```sh
npm ci
node scripts/check-b003-pty.js
```

Pythonが別名の環境では `B003_PYTHON=/path/to/python3` を指定する。Mac上で、合成タッチ→Backend生成命令→ACK→解錠成功→貸出中→施錠成功→返却済み、解錠失敗時の承認維持、施錠失敗時の貸出中維持を確認済み。タッチ返信を1回落として同じフレーム・UUIDでの再送と解錠命令1件を確認し、Pythonを再起動して命令を再送し、保存結果の返信と再駆動ゼロも確認した。

### 別ターミナルで手動接続

1. Python側を起動する。初回は新規試験用ディレクトリの台帳パスを使う。同一命令の再起動試験では台帳を再利用する。

   ```sh
   python3 tools/run_b003_lock.py --pty --card-input stdin --mock-drive success \
     --db /tmp/b003-first-test-commands.sqlite
   ```

2. 別ターミナルで、隔離した試験DBを指定してBackendを起動する。`SERIAL_PORT` はPythonが標準出力に表示した値。Pythonを再起動したら表示されたポートでBackendを起動し直す。

   ```sh
   DATABASE_PATH=/path/to/isolated-test.sqlite SERIAL_MODE=usb \
     SERIAL_PORT=/dev/ttysNNN SERIAL_BAUD_RATE=115200 SERIAL_RELAY_ID=RELAY01 npm start
   ```

3. 試験DBにB003を `BIKE03` / `RELAY01` で登録し、合成カード `0123456789ABCDEF` と承認済み試験申請を紐付けておく。Python側の標準入力に `0123456789ABCDEF` を1行入力すると、通常のUSB v1 `card_tap` が送られる。成功時はBackendの返却操作で施錠を試す。失敗試験は新しい試験申請を用意し、`--mock-drive fail-unlock` または `--mock-drive fail-lock` を選ぶ。自動確認はこれらの試験データをケースごとに作成する。

## 後続の実機接続

| 項目 | 構成・状態 |
| --- | --- |
| B003登録用ID | `device_id=BIKE03`、`relay_id=RELAY01`。Backend資料の例に合わせて選定。試験DBへの登録はBackend担当待ち |
| カードリーダー | RC-S330をB003側のPythonホストにUSB接続。FeliCaのカード除去を待って次のタッチを受け付ける |
| Backendへの接続 | 信頼済みの双方向シリアルリンク。115200 baud、8N1、フロー制御なし、UTF-8 JSON Lines。両側で別々のポートを開く |
| 制御基板・ロック・電源 | B003で使用する型番と配線は確認待ち |
| 位置検知 | ロック機構の解錠端と施錠位置を独立に確認。センサーの型番・位置・入力極性は確認待ち |

## 起動

1. RC-S330をB003ホストに接続する。BackendホストとB003ホストに、相互に接続されたシリアルポートを用意する。USB-UARTを2本使う場合は電圧規格を揃え、TX/RXを交差してGNDを共通にする。電源線は接続しない。
2. B003ホストに `nfcpy`、対応する `libusb`、`pyserial` を導入する。実機用Pythonモジュールをローカルの `PYTHONPATH` に置く。モジュールは `drive(action)` と `confirms_position(action)` を提供し、物理位置を期限内に確認した場合だけ `True` を返す。駆動指令の終了や固定待ち時間は成功判定に使わない。Backendの結果タイムアウト10秒以内に駆動・検知を終える。
3. Backendの隔離試験環境にB003のIDを登録し、`SERIAL_MODE=usb`、`SERIAL_PORT=<Backend側ポート>`、`SERIAL_BAUD_RATE=115200`、`SERIAL_RELAY_ID=RELAY01` で起動する。
4. B003側を起動する。再起動時も同じ台帳を使用する。台帳・実機設定ファイルはリポジトリ外に置く。

```sh
python3 tools/run_b003_lock.py --port /dev/cu.usbserial-DEVICE \
  --db "$HOME/.b003-commands.sqlite" --driver b003_site_driver
```

ポート名とドライバ名は例。カードIDmはタッチフレームでのみ送信し、ログと命令台帳には記録しない。

## 確認済みと残件

- ローカル7件成功。模擬FeliCaの読取イベント、部分受信・CRLF・過大行破棄、USB相当の経路からB003Lockへの命令・応答を確認した。
- 今回の実機確認項目はゼロ。対象USBシリアルポートを検出できず、B003の実カード、実USB、解錠・施錠、成功検知は未確認。
- 駆動・位置検知の実装には、制御基板、モーター／サーボ／電磁錠、ドライバ回路、電源の型番と定格、制御ピン・信号・駆動限界、解錠側と施錠側のセンサー型番・配線・入力極性が必要。中継器が既製機材の場合は型番とUSB側／ロック側の接続方式も確認する。センサーがなければロック機構の端位置・掛かりを計測できる部材の選定を残件とする。
