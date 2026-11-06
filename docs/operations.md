# Operasyon notları

## Yapılandırma

| Değişken                                                  | Açıklama                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `DataPath`                                                | SQLite, upload parçaları ve worker çalışma klasörleri; varsayılan `.runtime` |
| `MediaPath`                                               | API ve worker tarafından paylaşılan özel medya klasörü                       |
| `DatabaseProvider`                                        | PostgreSQL için `Postgres`; diğer durumlarda SQLite                          |
| `ConnectionStrings__Default`                              | Postgres seçildiğinde bağlantı dizesi                                        |
| `PublicOrigin`                                            | Web arayüzünün tam origin'i; varsayılan `http://127.0.0.1:9260`              |
| `AdminPassword`                                           | Production ilk başlatmada zorunlu yönetici parolası                          |
| `FFmpegPath`, `FFprobePath`                               | FFmpeg / ffprobe executable yolları veya PATH komutları                      |
| `FontPath`                                                | drawtext için TTF dosyası                                                    |
| `S3__Endpoint`                                            | İsteğe bağlı S3 / MinIO endpoint'i, ör. `localhost:9000`                     |
| `S3__Bucket`, `S3__AccessKey`, `S3__SecretKey`, `S3__Ssl` | S3 ayna ayarları; bucket önceden oluşturulmalı                               |

S3 etkinse yazılan nesne önce S3'e, sonra yerel cache'e kaydedilir. Cache'te olmayan nesne yeniden indirilir. Bucket herkese açık olmamalıdır. API ve worker aynı ayarları kullanmalı; upload parçaları için aynı `DataPath` gerekir. Docker'daki paylaşılan volume bunu sağlar.

## Hesap ve erişim

Yeni hesap yönetici oturumuyla `POST /api/users` üzerinden oluşturulur: `{ "username": "editor1", "name": "Editör", "password": "en-az-12-karakter" }`. Web paylaşım ekranı mevcut kullanıcıya izleyici / düzenleyici erişimi verir. Yalnızca proje sahibi paylaşımı değiştirebilir. İzleyici yorum yazabilir ve hazır çıktıyı indirebilir; projeyi değiştiremez.

Parolalar PBKDF2-SHA256 ile salt eklenerek türetilir. Oturumlar 12 saatlik, sunucuda SHA-256 özetiyle saklanan token'lara bağlıdır. Web HttpOnly / SameSite Strict cookie kullanır; HTTPS'te Secure niteliği açılır. İsteklerde Origin kontrol edilir. Yerel geliştirme hesapları internete yayınlanmamalıdır.

## İş kuyruğu

`queued → running → completed / failed`, çıktı iptalinde `cancel_requested → cancelled`. Yalnızca render iptal edilebilir. Lease süresi 20 saniye, heartbeat aralığı 1,5 saniyedir. Worker kaybolursa lease bittikten sonra başka worker işi alır. Eski lease sahibi sonucu yayımlayamaz. FFmpeg işlemlerinde shell kullanılmaz; argüman listesi, yerel protokol / biçim izinleri ve süre sınırı uygulanır. Worker yine de yalnızca güvenilen, limitlenmiş bir ortamda çalıştırılmalıdır.

Her render başlangıçtaki belgeyi ve revizyonu JSON olarak saklar. Tekrar deneme aynı kurguyu işler. Düzenleme yapmak için başarısız çıktıyı tekrar denemek yerine yeni bir render başlat.

## Depolama ve yedekleme

V1 şeması ilk açılışta kurulur. Güncelleme öncesi veritabanı ile medyayı birlikte yedekle. Otomatik saklama süresi / çöp toplama yoktur. `.runtime/uploads`, `.runtime/work` ve medya klasörü zamanla büyür. Aktif işlere ait dosyaları silme. Bu sürüm çok instance'lı API deployment'ı için dağıtık upload kilidi sağlamaz.

## Bilinen önizleme farkları

Önizleme düşük çözünürlüklü proxy ile oynar. Başlık boyutu çerçeveye göre ölçeklenir; tarayıcı ile FFmpeg font ölçümlerinde küçük farklar olabilir. Uzun satırlarda FFmpeg otomatik satır sarması yapmaz; başlığa elle satır sonu ekle. Geçiş siyaha açılma / kararmadır, kliplerin üst üste bindiği cross-dissolve değildir.
