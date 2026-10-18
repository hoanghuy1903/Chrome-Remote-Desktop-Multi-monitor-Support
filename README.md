# CRD Multi-Monitor

Extension cho Chrome giúp Chrome Remote Desktop (bản web, `remotedesktop.google.com`) hiển thị **mỗi màn hình của máy từ xa trên một màn hình riêng của máy bạn**.

## Cách hoạt động

1. Khi bạn chọn **Show all displays**, CRD nhận một luồng video riêng (WebRTC) cho mỗi màn hình từ xa và vẽ mỗi luồng vào một `<canvas>`, đặt cạnh nhau trong tab.
2. Extension ghép từng canvas với luồng video cấp hình cho nó (bằng cách so sánh ảnh thu nhỏ), rồi mở cho mỗi màn hình từ xa một cửa sổ popup phát thẳng luồng đó. Không phải mã hóa lại, nên hình giữ nguyên chất lượng.
3. Popup được chuyển sang màn hình cục bộ bạn chọn (qua `chrome.windows` + `chrome.system.display`) và có thể tự bật toàn màn hình.
4. Chuột, cuộn và bàn phím trong popup được đổi sang tọa độ của canvas tương ứng trong tab CRD rồi gửi vào canvas đó dưới dạng sự kiện DOM bình thường. CRD xác định màn hình từ canvas nhận sự kiện và tính vị trí từ khung của canvas, không kiểm tra sự kiện là thật hay giả, nên gửi sang máy từ xa như input thật. Không cần quyền debugger, nên Chrome không hiện thanh cảnh báo nào.

Nếu CRD chỉ hiển thị một khung hình ghép (bản cũ hoặc giao diện khác), extension cắt khung đó thành nhiều vùng theo phần **Bố cục**.

## Cài đặt

1. Mở `chrome://extensions`.
2. Bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked** rồi chọn thư mục này.

Sau mỗi lần sửa file: bấm nút tải lại ↻ ở thẻ extension, **rồi tải lại tab CRD** (F5). Tab đang mở vẫn chạy bản cũ cho tới khi được tải lại.

## Sử dụng

1. Kết nối tới máy từ xa trên `remotedesktop.google.com`.
2. Mở bảng bên của CRD → **Displays** → chọn **Show all displays**.
3. Bảng **CRD Multi-Monitor** hiện ở góc dưới bên phải. Bật/tắt bằng biểu tượng extension hoặc **Alt+Shift+M**.
4. Với mỗi "Màn hình từ xa", chọn màn hình trên máy bạn sẽ hiển thị nó, rồi bấm **Mở** (hoặc **Mở tất cả**).
5. Thoát toàn màn hình bằng **F11** (hoặc **giữ Esc** nếu đang khóa phím hệ thống, xem dưới). Đóng popup như một cửa sổ bình thường.

### Giữ một màn hình ở tab CRD

Ô **"Tab này hiển thị"** trong bảng (mặc định: *Chỉ màn hình từ xa 1*) cho tab CRD chỉ hiện một màn hình, phóng to vừa tab. Các màn hình còn lại chỉ xem qua popup; **Mở tất cả** sẽ bỏ qua màn hình đang ở tab.

- Trên tab CRD bạn thao tác như CRD gốc.
- Các màn hình kia vẫn nằm trong tab nhưng trong suốt, ngay dưới màn hình đang hiện. Input từ popup được gửi thẳng vào canvas của màn hình đó, nên không ảnh hưởng đến màn hình đang hiện.
- Chọn *Tất cả màn hình (như CRD gốc)* để trở về cách hiển thị ban đầu.

### Phím hệ thống (Win, Alt+Tab, Alt+F4, Ctrl+W…)

Bình thường Windows và Chrome xử lý các tổ hợp này trước khi trang web nhận được. Khi bật **"Gửi cả phím hệ thống"** trong bảng (mặc định bật), popup dùng Keyboard Lock API để giữ chúng lại và gửi sang máy từ xa.

- Keyboard Lock chỉ hoạt động khi trang ở chế độ toàn màn hình của trang (không phải F11). Vì vậy lần đầu bạn bấm chuột hoặc gõ phím vào popup, popup sẽ tự vào chế độ đó.
- Muốn thoát: **giữ Esc** khoảng 2 giây. Nhấn Esc ngắn vẫn được gửi sang máy từ xa.
- Trong lúc khóa, Alt+Tab và phím Win tác động lên máy từ xa. Muốn chuyển sang cửa sổ khác trên máy bạn, hãy dùng chuột hoặc thoát toàn màn hình trước.
- **Ctrl+Alt+Del** không bao giờ bắt được, vì Windows dành riêng tổ hợp này. Dùng nút **Press Ctrl+Alt+Del** trong bảng bên của CRD.

> Mỗi cú click chỉ cho phép mở một popup. Muốn **Mở tất cả** mở được nhiều cửa sổ cùng lúc, hãy bấm biểu tượng chặn popup trên thanh địa chỉ và chọn **Luôn cho phép**.

## Giới hạn và xử lý sự cố

- **Con trỏ lệch vài pixel**: tọa độ được quy đổi theo kích thước canvas trong tab CRD. Tab CRD càng lớn (maximize) thì quy đổi càng chính xác.
- **Chuột/phím trong popup không có tác dụng**: tải lại tab CRD (F5). Nếu vẫn không được, có thể Google đã đổi cách CRD xử lý input; khi đó cần sửa lại `content.js`.
- **Tab CRD phải còn mở** (có thể để ở màn hình phụ hoặc phía sau popup). Đừng thu nhỏ (minimize) tab đó.
- Chưa hỗ trợ: chế độ chuột tương đối (Relative mouse mode), đồng bộ clipboard qua popup.

## Tệp

| Tệp | Vai trò |
|---|---|
| `manifest.json` | Khai báo extension (Manifest V3) |
| `background.js` | Liệt kê màn hình cục bộ, đặt vị trí và toàn màn hình cho popup |
| `content.js` | Bảng điều khiển, tìm các màn hình từ xa, cửa sổ xem, đổi tọa độ input |
