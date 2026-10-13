# Soạn Đề Kiểm Tra Giáo Lý

Ứng dụng web soạn đề kiểm tra cho các lớp giáo lý. Ứng dụng chạy trên **Cloudflare Workers** (có kèm trang tĩnh), lấy mã nguồn từ **GitHub** và dùng được **tên miền riêng** của giáo xứ.

Các chức năng chính:
- Quản lý lớp học và giáo trình (nhập tệp Word, PDF có chữ, .txt, hoặc dán nội dung).
- Claude soạn câu hỏi dựa trên giáo trình của lớp: trắc nghiệm, Đúng/Sai, điền khuyết, tự luận.
- Đề trình bày trên trang A4: logo, đầu đề, dòng "Tên Thánh, họ và tên", ô điểm, lời phê, ô ký của người ra đề và Ban Giám Hiệu.
- Đáp án và hướng dẫn chấm có căn cứ giáo trình. Xuất Word (.docx).
- Kho đề lưu chung, có quy trình gửi duyệt và ký duyệt.
- Tài khoản đăng nhập với ba vai trò: **Quản trị / BGH**, **Giáo lý viên**, **Chỉ xem**.

## Cấu trúc thư mục

```
public/            Giao diện (trang tĩnh)
  index.html       Ứng dụng
  shim.js          Lớp kết nối giao diện với máy chủ
  accounts.js      Đăng nhập, quản lý tài khoản
src/worker.js      Điểm vào của Worker: /api/* → máy chủ, còn lại → trang tĩnh
src/api.js         Máy chủ: đăng nhập, cơ sở dữ liệu, gọi Claude
wrangler.toml      Cấu hình Cloudflare (D1, biến môi trường)
```

## Chi phí

- **Cloudflare Pages và D1:** gói miễn phí đủ dùng cho một ban giáo lý.
- **Claude API:** trả theo lượng dùng, mỗi lần bấm "Soạn đề bằng Claude" là một lượt. Xem bảng giá tại https://www.anthropic.com/pricing.
- Biến `CLAUDE_DAILY_LIMIT` giới hạn số lượt mỗi người mỗi ngày (mặc định 60).

---

## Triển khai từng bước

### Bước 1: Đưa mã lên GitHub

1. Đăng nhập https://github.com và tạo repository mới, ví dụ `soan-de-giao-ly`. Có thể chọn **Private**.
2. Tải toàn bộ thư mục này lên repo bằng nút "Add file → Upload files", hoặc dùng lệnh:

```bash
cd soan-de-giao-ly
git init
git add .
git commit -m "Soạn Đề Kiểm Tra Giáo Lý"
git branch -M main
git remote add origin https://github.com/<tai-khoan>/soan-de-giao-ly.git
git push -u origin main
```

### Bước 2: Tạo cơ sở dữ liệu D1

1. Đăng nhập https://dash.cloudflare.com (đăng ký miễn phí nếu chưa có).
2. Vào **Storage & Databases → D1 SQL Database → Create**.
3. Đặt tên `soan-de-giao-ly` rồi bấm Create.
4. Sao chép **Database ID** (chuỗi dạng `xxxxxxxx-xxxx-...`).
5. Mở tệp `wrangler.toml` trên GitHub. Thay `THAY-BANG-DATABASE-ID-CUA-BAN` bằng ID vừa sao chép, rồi commit.

Không cần tạo bảng: máy chủ tự tạo bảng ở lần chạy đầu tiên.

### Bước 3: Tạo Worker kết nối GitHub

1. Vào **Workers & Pages → Create application → Import a repository** (phần Workers).
2. Chọn tài khoản GitHub và repo `soan-de-giao-ly`.
3. Cấu hình:
   - **Project name:** `soan-de-giao-ly` (phải trùng dòng `name` trong `wrangler.toml`)
   - **Build command:** để trống
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** `/`
4. Bấm **Deploy**. Địa chỉ có dạng `soan-de-giao-ly.<ten-tai-khoan>.workers.dev`.

Cloudflare đọc `wrangler.toml` và tự gắn database D1 với tên biến `DB`.

### Bước 4: Cài khoá API Claude

1. Vào https://console.anthropic.com. Tạo tài khoản, nạp tiền (Billing), rồi vào **API Keys → Create Key**.
2. Trong Cloudflare, mở Worker `soan-de-giao-ly`: **Settings → Variables and Secrets → Add**.
   - Type: **Secret**
   - Name: `ANTHROPIC_API_KEY`
   - Value: khoá vừa tạo (bắt đầu bằng `sk-ant-...`)
3. Secret có hiệu lực ngay, không cần triển khai lại.

Tuyệt đối không ghi khoá API vào mã nguồn hay `wrangler.toml`.

### Bước 5: Gắn tên miền riêng

1. Trong Worker: **Settings → Domains & Routes → Add → Custom domain**.
2. Nhập tên miền, ví dụ `dethi.giaoxuabc.org` hoặc `giaoly.giaoxuabc.vn`.
3. Cách cấu hình tuỳ nơi quản lý tên miền:
   - **Tên miền đã quản lý DNS trên Cloudflare:** Cloudflare tự tạo bản ghi, chỉ cần bấm Activate.
   - **Tên miền ở nhà cung cấp khác** (Mắt Bão, PA Việt Nam, GoDaddy…): Worker chỉ gắn được tên miền đã quản lý DNS trên Cloudflare. Thêm tên miền vào Cloudflare (**Domains → Onboard a domain**, gói Free), đổi nameserver ở nhà cung cấp sang 2 nameserver Cloudflare đưa, chờ kích hoạt rồi quay lại bước 1.
4. Chờ vài phút đến vài giờ cho DNS cập nhật. Chứng chỉ HTTPS được cấp tự động.

### Bước 6: Sử dụng lần đầu

1. Mở tên miền của bạn. Lần đầu, trang sẽ yêu cầu **tạo tài khoản quản trị**.
2. Vào **Cài đặt**:
   - Điền Giáo phận, Giáo xứ, năm học.
   - Tải logo xứ đoàn và logo Ban Giáo Lý.
   - Tạo tài khoản cho Ban Giám Hiệu (vai trò Quản trị) và các giáo lý viên.
3. Gửi tên đăng nhập và mật khẩu ban đầu cho từng người. Họ tự đổi mật khẩu trong **Cài đặt → Tài khoản**.

---

## Cập nhật về sau

Mỗi lần sửa mã và push lên nhánh `main`, Cloudflare tự triển khai lại. Dữ liệu trong D1 vẫn được giữ nguyên.

## Sao lưu dữ liệu

Cài Node.js, rồi chạy:

```bash
npx wrangler login
npx wrangler d1 export soan-de-giao-ly --remote --output=saoluu-$(date +%F).sql
```

Nên sao lưu định kỳ, ví dụ mỗi tháng và trước mỗi kỳ thi.

## Chạy thử trên máy (tuỳ chọn)

```bash
npx wrangler dev
```

Khoá API khi chạy thử đặt trong tệp `.dev.vars` (đã có trong `.gitignore`):

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Tuỳ chỉnh trong `wrangler.toml`

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `CLAUDE_MODEL` | Model Claude dùng để soạn đề | `claude-sonnet-5-5` |
| `CLAUDE_DAILY_LIMIT` | Số lượt Claude tối đa mỗi người mỗi ngày | `60` |
| `CLAUDE_MAX_TOKENS` | Độ dài tối đa câu trả lời của Claude | `16000` |

## Phân quyền

| Vai trò | Được làm |
|---|---|
| Quản trị / BGH | Mọi thao tác; duyệt đề; sửa cài đặt và logo; quản lý tài khoản |
| Giáo lý viên | Tạo lớp, nhập giáo trình, soạn đề, sửa và xoá đề của mình, gửi duyệt, xem và xuất mọi đề |
| Chỉ xem | Xem kho đề, xuất Word |

Quyền được kiểm tra ở máy chủ, không chỉ ẩn nút trên giao diện. Mật khẩu được băm bằng PBKDF2. Phiên đăng nhập kéo dài 30 ngày.
