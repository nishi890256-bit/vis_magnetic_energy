Magnetic Energy Visualization

このフォルダのファイルを、既存のwebフォルダに上書きしてください。
HTMLファイル名は index.html にしてください。

必要な配置：
  web/
    index.html
    app.js
    style.css
    README.txt
    scene.json
    bounds.json
    summary.json
    meshes/
      magnetic_energy_100_iso_1.ply
      magnetic_energy_100_iso_2.ply
      magnetic_energy_100_iso_3.ply
      magnetic_energy_100_iso_4.ply
      magnetic_energy_100_iso_5.ply
      magnetic_energy_100_iso_6.ply

scene.json は export_magnetic_energy.py が生成したものを使います。
色は color_rgb、透明度は opacity、カラーバーは color_map.samples を読み込みます。
このページはカラーマップ Rainbow Uniform、範囲0〜6、等値面1〜6用です。
bounds.json は scene.json に領域情報がない場合に使います。
summary.json は記録用です。このページの表示処理では使いません。
Web側で元のVTRを読み込む必要はありません。

手元で確認：
  1. ターミナルで既存の web フォルダに移動する。
  2. 次を実行する：
       python3 -m http.server 8000
  3. ブラウザで次を開く：
       http://localhost:8000/index_y_up.html
  4. サーバーを止めるときは Ctrl+C。

index.html をダブルクリックして開くと、JSONとPLYの読み込みができません。
更新が反映されない場合は Ctrl+Shift+R で再読み込みしてください。
Three.jsをCDNから読むため、インターネット接続が必要です。

操作：
  左ドラッグ / 1本指：回転
  ホイール / ピンチ：拡大・縮小
  右ドラッグ / 2本指：移動
  左上のメニュー：各等値面の表示切替
  領域枠：計算領域の枠の表示切替
  視点を戻す：初期の視点に戻す

初期表示と「視点を戻す」の軸方向：
  +y：画面上、+z：画面左下、+x：画面右下。
  右下の軸表示は、実際のカメラから見た各軸の向きを示します。
  index_y_up.html は index.html と同内容の確認用ページです。
  古いトップページがキャッシュされている場合も、このURLで確認できます。

GitHub Pagesで公開：
  この web フォルダの中身を、公開するリポジトリのルートへアップロードします。
  meshes フォルダも同じ階層へアップロードしてください。
  index.html、scene.json、meshes の相対位置を維持してください。

表示上の注意：
  透過する等値面が重なる場所は、ブラウザとParaViewで見え方が異なることがあります。
  メッシュの色と透明度の値には、出力済みJSONの値を使っています。
