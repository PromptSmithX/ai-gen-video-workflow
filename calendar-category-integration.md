# POD Video Studio — Calendar Category Integration

**Loại tài liệu:** Feature integration brief cho coding agent  
**Phạm vi:** Chỉ bổ sung loại sản phẩm lịch vào POD Video Studio hiện tại. Không thay thế hoặc tái thiết kế pipeline tạo video đang chạy cho áo thun.  
**Repo:** `PromptSmithX/ai-gen-video-workflow`  
**Branch tham chiếu:** `main`  
**Ngày:** 2026-11-25  
**Trạng thái:** Đề xuất triển khai — cần spike kỹ thuật cho tracking/compositing trước khi bật production.

---

## 0. Mục tiêu và nguyên tắc không được phá vỡ

Mở rộng POD Video Studio để nhân viên có thể chọn **Desk Calendar**, thả vào đúng hai ảnh:

1. **Front cover** — ảnh bìa/mockup lịch. Đây là ảnh duy nhất gửi qua pipeline hiện tại: POD Video Studio → Muse4AI → Muse.ai.
2. **Interior artwork** — artwork gốc của trang bên trong (ví dụ January). Ảnh này được giữ và xử lý hoàn toàn ở local; **không gửi làm reference thứ hai cho Muse**.

Sau khi Muse trả MP4, ứng dụng dùng computer vision/compositing để đặt artwork gốc lên vùng trang giấy bên trong video. Mục đích là tránh để mô hình video tự vẽ lại chữ, số ngày và minh họa trên trang lịch.

### Nguyên tắc bắt buộc

- Luồng T-shirt hiện tại phải tiếp tục hoạt động như trước, không đổi UI, prompt, provider payload hoặc output cho apparel trừ các thay đổi dùng chung có kiểm thử tương thích.
- Không thay Muse4AI, không thêm một video provider khác, không gọi thẳng API không được phê duyệt của Muse.
- Không giả định Muse bridge hỗ trợ nhiều reference image trong một job. Contract hiện tại nhận một `sourceImagePath` và một `reference_id`.
- Front cover là provider reference. Interior artwork là local-only asset.
- Không dùng image/video generative AI để vẽ lại interior artwork sau khi nhận file của người dùng.
- Artwork gốc phải được lưu nguyên byte (byte-identical copy), có SHA-256 để truy vết.
- Nếu tracking không đủ tin cậy, không xuất video với artwork sai vị trí. Đánh dấu xử lý hậu kỳ thất bại và cho phép retry download/post-process mà không tạo thêm job Muse.
- Giữ nguyên idempotency, trạng thái job, bảo vệ secrets, lưu trữ local và quy tắc logging hiện hành.

## 1. Repository hiện tại — các điểm cần kế thừa

Tài liệu này được viết dựa trên cấu trúc và contract hiện tại trong repository, không giả định một ứng dụng mới.

| Thành phần hiện tại | Hành vi hiện tại | Tác động của Calendar |
|---|---|---|
| `src/renderer/src/screens/CreateVideo.tsx` | Một dropzone, từ chối hơn một file; dùng một `stagedImage` | Thêm dropzone thứ hai chỉ khi chọn Calendar |
| `src/shared/ipc.ts` | `CreateJobInput` có `sourceToken` | Thêm optional `interiorArtworkToken` |
| `src/shared/domain.ts` | `Category.promptGroup` chỉ có apparel/drinkware/home-decor/other | Thêm `calendar` |
| `src/main/app/image-staging.ts` | Có thể stage nhiều token riêng biệt; mỗi token trỏ đến một file | Có thể tái sử dụng, không cần đổi cơ chế staging |
| `src/shared/provider.ts` | `GenerateVideoInput` có một `sourceImagePath` và một `sourceFileName` | Giữ nguyên; chỉ front cover đi qua provider |
| `src/main/providers/muse/rest-bridge.ts` | Upload một reference và submit job với một `reference_id` | Giữ nguyên provider/bridge contract |
| `src/main/prompts/service.ts` | Đọc `prompts/master/*.md` và `prompts/categories/<group>.md` | Thêm calendar template và category snippet |
| `src/main/app/job-orchestrator.ts` | Lưu source + prompt snapshot, submit một source image, download MP4 rồi lưu ngay | Lưu thêm artwork asset và chèn post-processing trước `storeVideo()` |
| `src/main/infra/db/migrations.ts` | `assets.role` có CHECK constraint gồm 4 role | Migration để thêm `interior_artwork` |
| `src/main/infra/media/index.ts` | Validate/copy ảnh byte-identical, validate và lưu MP4 | Thêm phương thức import artwork chuyên biệt; tái sử dụng validation/storage |
| `src/main/infra/config/index.ts` | `promptGroup` enum chỉ có 4 giá trị; stored categories thay thế defaults | Thêm `calendar`, đảm bảo category mới có mặt ở cài đặt cũ |

### Files cần đọc trước khi code

- `POD_VIDEO_STUDIO_AGENT_BRIEF.md`
- `docs/architecture/current-state.md`
- `docs/tasks/COMMON.md`
- `docs/tasks/W1-domain-db-media.md`
- `docs/tasks/W2-prompts.md`
- `docs/tasks/W3-muse-provider.md`
- `docs/tasks/W4-ui.md`
- `docs/tasks/W6-orchestrator-ipc.md`
- `docs/api/muse-provider-contract.md`
- `src/shared/domain.ts`, `src/shared/ipc.ts`, `src/shared/provider.ts`, `src/shared/services.ts`
- `src/main/app/job-orchestrator.ts`, `src/main/infra/media/`, `src/main/prompts/`

## 2. Luồng người dùng sau khi tích hợp

### 2.1. Apparel — không thay đổi

- Người dùng chọn T-shirt/Hoodie/Sweatshirt.
- Chỉ hiển thị dropzone hiện tại.
- Một ảnh mockup được stage, prompt apparel được render.
- Provider hiện tại nhận một reference image.
- MP4 được download, validate và lưu như hiện tại.

### 2.2. Calendar — nhánh mới

Khi `category.promptGroup === 'calendar'`:

1. Hiển thị dropzone **Front Cover**.
2. Hiển thị dropzone **Interior Artwork**.
3. Người dùng nhập SKU, tên sản phẩm và chọn review style như form hiện tại.
4. Chọn template `calendar-review` tự động; người dùng vẫn có thể xem/chỉnh prompt nếu quyền hiện tại cho phép.
5. Nút Generate chỉ bật khi cả hai ảnh hợp lệ, SKU/category/template/prompt hợp lệ và provider ready (hoặc mock mode).
6. Front cover được gửi tới provider theo pipeline hiện tại.
7. Interior artwork được lưu local và gắn với job, không upload sang Muse4AI/Muse.
8. Muse trả video review có thao tác lật sang trang giấy nội thất **màu kem trống** hoặc vùng in trống, giữ trang ổn định hướng camera.
9. Ứng dụng local nhận diện trang, tracking bề mặt, compositing artwork gốc lên trang và giữ lớp tay ở foreground khi có thể.
10. Validate MP4 cuối cùng, lưu vào SKU library, metadata có SHA-256 của artwork và báo cáo post-process.

### 2.3. UX yêu cầu

- Hai upload zone có label rõ ràng, không dùng một dropzone chung để đoán thứ tự hai file.
- Mỗi zone nhận một ảnh PNG/JPG/WEBP riêng.
- Có preview riêng cho front cover và interior artwork.
- Có nút Remove/Replace riêng từng ảnh.
- Nếu người dùng chuyển từ Calendar sang category khác, artwork thứ hai không được gửi nhầm vào job apparel. Có thể giữ state để quay lại hoặc clear, nhưng payload cho category không phải Calendar không được chứa `interiorArtworkToken`.
- Hiển thị cảnh báo nhẹ nếu tỷ lệ artwork và tỷ lệ vùng in dự kiến lệch đáng kể.
- Trong Library, Calendar job nên cho xem được source cover, interior artwork đã lưu và final video để kiểm tra.

## 3. Product category và prompt system

### 3.1. Category mới

Thêm default category:

```ts
{ id: 'desk-calendar', label: 'Desk Calendar', promptGroup: 'calendar' }
```

Thay đổi cần có:

- `src/shared/domain.ts`: thêm `'calendar'` vào `Category.promptGroup` và `DEFAULT_CATEGORIES`.
- `src/shared/ipc.ts`: thêm `'calendar'` vào `CategorySchema.promptGroup`.
- `src/main/infra/config/index.ts`: thêm `'calendar'` vào category Zod schema.
- Config migration/normalization: category list trong `settings` hiện có đang thay thế hoàn toàn `DEFAULT_CATEGORIES`. Khi nâng cấp, nếu category list hiện hữu chưa có `desk-calendar`, append category mặc định này mà không ghi đè category tùy chỉnh hiện có. Không làm mất hoặc đổi label của category do admin tự tạo.
- Admin Categories UI: cho phép chọn `calendar` prompt group.

Không cần thay đổi schema `products.category`, vì trường này đã lưu category id dưới dạng text.

### 3.2. Template riêng cho Calendar

Không dùng mặc định T-shirt Prompt Master cho Calendar. Repository có company Prompt Master được bundle tại `tshirt-review-v2.md`, và company template hiện có thể trở thành default toàn cục của `product-review`. Dùng template áo cho Calendar sẽ mang theo logic garment không phù hợp.

Thêm:

- `prompts/master/calendar-review-v1.md`
- `prompts/categories/calendar.md`

Template ID đề xuất: `calendar-review`, version `v1`.

UI mapping:

- `promptGroup === 'calendar'` → tự chọn template `calendar-review` (ưu tiên admin/company version nếu có; fallback built-in `v1`).
- Nhóm khác tiếp tục dùng template hiện tại (thường là `product-review`).
- Khi người dùng chủ động chọn template khác, không tự ghi đè lựa chọn thủ công trừ khi họ đổi category.

Built-in template hiện được PromptService đánh dấu `isPlaceholder: true`. Giữ cảnh báo PLACEHOLDER cho đến khi công ty duyệt prompt Calendar qua Admin/Prompt Master. Không bỏ cờ placeholder chỉ để ẩn cảnh báo.

### 3.3. Nội dung `prompts/categories/calendar.md`

Category snippet phải dạy Muse tạo cảnh review lịch, không yêu cầu Muse vẽ artwork trang trong:

- Lịch xoắn lò xo dạng để bàn, cùng cấu trúc vật lý với front cover.
- Người review cầm lịch bằng hai tay, giới thiệu bìa, lật một trang thật tự nhiên.
- Trang bên trong là giấy màu kem trống, không chữ, không số, không illustration, không hoa văn. Artwork sẽ được POD compositing local sau khi nhận video.
- Sau khi lật, giữ trang hướng gần thẳng camera và tương đối phẳng đủ lâu; cạnh giấy và bốn góc phải nhìn thấy rõ.
- Lò xo luôn ở cạnh trên, không đổi định dạng sản phẩm.
- Người review cầm mép giấy; tránh bàn tay đi qua vùng in chính.
- Chỉ một lần lật trang, không lật hàng loạt.
- Có lời thoại review tự nhiên; không thêm claim, giá, rating hoặc badge.
- Không để camera zoom/rotate quá mạnh trong đoạn trang bên trong đang được giữ.

### 3.4. Nội dung template `calendar-review-v1.md`

Template nên dùng biến được hỗ trợ hiện tại (`sku`, `product_category`, `product_name`, `source_image_filename`, `duration_seconds`, `aspect_ratio`, `review_style`) và `{{category_rules}}`. Không thêm placeholder mới nếu chưa cập nhật `PROMPT_VARIABLES` và renderer.

Nội dung yêu cầu chính:

- Present/pick up the exact front cover reference.
- Human reviewer holds and speaks naturally.
- Turn exactly one front cover/page around the existing top spiral binding.
- Reveal a clean blank cream interior page; never synthesize an interior artwork.
- Keep the open page visible, flat, front-facing and stable for a post-processing window.
- Keep the printed surface free from hands as much as possible.
- Preserve one physical calendar and consistent proportions.

Quality checks hiện tại phải tiếp tục pass: preserve_artwork, no_design_changes, consistent_product, natural_texture, physical_continuity, no_impossible_transitions, human_review_action, no_fake_claims. Nếu cụm từ hiện tại chỉ nói về garment/fabric thì cập nhật phần template Calendar hoặc làm wording quality rules trung tính hơn, nhưng không làm hỏng prompt apparel.

## 4. Upload contract và job input

### 4.1. IPC input

Giữ `sourceToken` hiện tại là front cover. Thêm trường optional:

```ts
interiorArtworkToken?: string;
```

`CreateJobInput` vẫn giữ cùng `clientRequestId` và cùng cơ chế idempotency.

Main process phải kiểm tra điều kiện theo category:

- Calendar: `interiorArtworkToken` bắt buộc và token phải tồn tại/chưa hết hạn.
- Non-calendar: không yêu cầu `interiorArtworkToken`; nếu có token do stale UI state, không được dùng nó cho job này.

Không đưa local absolute paths ra renderer. Renderer chỉ giữ `StagedImage.token` như cơ chế hiện tại.

### 4.2. Staging

`ImageStagingService` hiện hỗ trợ nhiều token độc lập, vì vậy có thể tái sử dụng nguyên trạng.

Trong UI gọi `api.images.stageFile(file)` riêng cho từng dropzone:

- `frontCoverStaged`
- `interiorArtworkStaged`

Không cần đổi `images.pick()` hoặc `images.stageFile()` thành API multi-file mới. Mỗi dropzone giữ quy tắc một file.

### 4.3. Validation

Cả hai ảnh đều phải đi qua `MediaLibrary.validateImage()`:

- PNG/JPEG/WEBP hợp lệ.
- Enforce `maxSourceBytes` và `maxSourcePixels`.
- Không tin extension.
- Không đọc hoặc xử lý image bytes ở renderer.

Front cover còn phải đáp ứng giới hạn `maxUploadBytes` của provider, vì ảnh này được gửi qua bridge. Interior artwork chỉ cần đáp ứng giới hạn local source image; không cần tính vào provider upload limit.

### 4.4. Prompt preview

Prompt preview tiếp tục dùng `PromptPreviewInput` hiện tại. File name của `source_image_filename` là front cover. Interior artwork filename là metadata riêng, không cần thêm vào prompt nếu không có nhu cầu hiển thị.

## 5. Storage và database

### 5.1. Asset roles

Thêm `interior_artwork` vào `AssetRole` trong `src/shared/domain.ts`.

Asset artwork là tài sản theo từng job, do đó insert với:

```ts
{
  productId,
  jobId: newJob.id,
  role: 'interior_artwork',
  path,
  mime,
  bytes,
  width,
  height,
  durationMs: null,
  sha256
}
```

Không cần thêm `interiorArtworkAssetId` vào `Job` nếu có thể tra cứu qua `db.assets.listByJob(jobId)` theo role. Cách này giảm thay đổi domain Job và migration job table.

### 5.2. Migration

`assets.role` hiện có SQLite CHECK constraint chỉ cho phép `source_image`, `generated_video`, `thumbnail`, `prompt_snapshot`. Thêm migration version 2 để mở rộng constraint với `interior_artwork`.

SQLite không hỗ trợ thay trực tiếp CHECK constraint trong table hiện có. Rebuild table trong migration:

1. Tạo `assets_new` với schema giống hệt hiện tại, chỉ mở rộng CHECK constraint.
2. Copy toàn bộ rows từ `assets` sang `assets_new`.
3. Drop bảng cũ và rename `assets_new` thành `assets`.
4. Tạo lại `idx_assets_product_id` và `idx_assets_job_id`.
5. Giữ nguyên IDs, foreign keys, paths, hashes, timestamps và tất cả assets cũ.

Migration phải tương thích cơ chế savepoint hiện có trong `runMigrations()`. Viết test mở database v1 fixture rồi migrate lên v2 và xác minh toàn bộ rows cũ còn nguyên.

### 5.3. File path và byte-identical import

Mở rộng `MediaLibrary` bằng method rõ nghĩa, ví dụ:

```ts
importInteriorArtwork(absPath: string, sku: string): Promise<StoredFile>
```

Lưu file vào:

```text
<POD_LIBRARY_ROOT>/<SKU>/source/<SKU>-interior-artwork.<ext>
<POD_LIBRARY_ROOT>/<SKU>/source/<SKU>-interior-artwork-2.<ext>
```

Yêu cầu:

- Dùng cùng validation và path-safety với `importSourceImage()`.
- Copy byte-identical, không resize/re-encode file gốc.
- Tính SHA-256.
- Không ghi absolute path vào DB hoặc metadata.
- Dọn file nếu DB transaction thất bại.

Front cover tiếp tục lưu bằng `importSourceImage()` như hiện tại.

### 5.4. Regenerate và retry

- `retry` và `retryDownload`: dùng lại cùng job và cùng artwork asset; không tạo generation request mới nếu chỉ retry download/post-process.
- `regenerate`: copy thêm một asset row `interior_artwork` gắn với new job, có thể trỏ đến cùng relative path và SHA-256 của artwork gốc. Không cần duplicate bytes nếu source asset còn tồn tại.
- Nếu artwork asset bị thiếu hoặc hash không khớp, không gửi job Calendar mới; trả lỗi an toàn `NOT_FOUND`/`INVALID_IMAGE`.

## 6. Muse4AI / Muse provider — giữ nguyên

Đây là ranh giới tích hợp quan trọng nhất.

### 6.1. Ảnh được gửi tới Muse

Chỉ gửi **front cover** qua provider hiện tại:

- `GenerateVideoInput.sourceImagePath` = front cover path.
- `GenerateVideoInput.sourceFileName` = front cover name.
- `POST /v1/references` chỉ upload front cover.
- `POST /v1/jobs` tiếp tục dùng một `reference_id` như contract hiện tại.

### 6.2. Interior artwork không gửi tới Muse

Interior artwork chỉ được dùng sau khi MP4 đã được tải về local. Không thêm reference ID thứ hai, không thay đổi `GenerateVideoInput`, không sửa request body của bridge và không thay đổi Muse4AI.

Lý do: contract hiện tại của `MuseProvider` là một source image; bridge contract được repo ghi nhận cũng dùng một `reference_id`. Không tự ý giả định multi-reference được hỗ trợ.

## 7. Local Calendar Artwork Compositor

### 7.1. Vị trí trong pipeline

Hiện tại `JobOrchestrator.handleDownloading()`:

1. Download provider MP4 vào `.part`.
2. Gọi `media.storeVideo()`.
3. Ghi metadata.
4. Insert `generated_video` asset và chuyển `SUCCEEDED`.

Thay đổi duy nhất: thêm bước post-process sau download và trước `media.storeVideo()` cho Calendar job.

```text
Muse MP4 download (.part)
        |
        +-- non-calendar --> media.storeVideo() (luồng hiện tại, không thay đổi)
        |
        +-- calendar --> CalendarArtworkCompositor
                             |
                             +--> processed MP4 (.part)
                                      |
                                      +--> validate + media.storeVideo()
```

### 7.2. Interface đề xuất

Tạo interface main-process, ví dụ:

```ts
export interface CalendarArtworkCompositor {
  process(input: {
    inputVideoPath: string;
    artworkPath: string;
    outputVideoPath: string;
    sku: string;
    jobId: string;
  }): Promise<CalendarCompositionReport>;
}

export interface CalendarCompositionReport {
  applied: boolean;
  artworkSha256: string;
  processedFrames: number;
  visibleFrames: number;
  trackingCoverage: number;
  lowConfidenceFrames: number;
  compositorVersion: string;
}
```

Interface cụ thể có thể đặt trong `src/shared/services.ts` hoặc contract main-only nếu không cần expose qua IPC. Orchestrator nhận dependency qua `OrchestratorDeps`; `AppContainer` khởi tạo implementation. Renderer không được gọi compositor trực tiếp.

### 7.3. V1 tracking strategy

MVP chỉ hỗ trợ desk calendar có trang nội thất tương đối phẳng và được giữ hướng về camera sau thao tác lật.

Quy trình xử lý:

1. Decode video theo frame; lấy frame/keyframe và thông tin thời gian.
2. Detect vùng giấy nội thất bằng page boundary/edge detection và segmentation nhẹ.
3. Xác định bốn góc trang ở frame đầu tiên có đủ độ rõ.
4. Theo dõi bốn góc/đặc trưng qua các frame bằng optical flow + robust homography (RANSAC).
5. Với từng frame, tính phép biến đổi phối cảnh từ artwork gốc lên quadrilateral của trang.
6. Tạo mask để artwork chỉ nằm trong vùng in, có inset nhỏ để không đè lên viền giấy/lò xo.
7. Composite trực tiếp ảnh nguồn; không gọi model generative để sửa artwork.
8. Giữ video/audio gốc, chỉ thay đổi pixel trong vùng trang.

Homography phù hợp cho tờ giấy phẳng. Nếu trang cong mạnh trong lúc lật, bốn điểm không đủ để mô hình hóa chính xác bề mặt; V1 không được giả vờ xử lý tốt trường hợp này. Khi tracking confidence thấp, tạm ẩn artwork trong frame không đủ chắc chắn và chỉ hiện lại khi trang ổn định, hoặc đánh dấu post-process thất bại.

### 7.4. Foreground hand occlusion

V1 prompt phải yêu cầu reviewer:

- Cầm lịch ở cạnh ngoài.
- Không đưa ngón tay qua vùng artwork chính sau khi mở.
- Giữ trang mở tương đối phẳng, hướng camera trong một đoạn ổn định.

Nếu có hand segmentation phù hợp, giữ tay ở foreground layer để bàn tay che artwork tự nhiên. Không bắt buộc tích hợp model segmentation nặng vào MVP nếu chưa chứng minh được hiệu quả/hiệu năng. Không overlay artwork lên trên ngón tay.

V2 có thể bổ sung segmentation tay/bìa và mesh deformation cho trang cong.

### 7.5. Yêu cầu cho video nền từ Muse

Prompt Calendar cần yêu cầu Muse tạo một trang nội thất trống:

- Warm cream / matte paper, không chữ, không số, không minh họa, không hoa văn.
- Bốn cạnh/biên giấy nhìn thấy rõ, độ tương phản đủ với background.
- Một thao tác lật trang duy nhất, tự nhiên.
- Sau khi lật, giữ trang mở và hướng gần thẳng camera trong ít nhất khoảng 2–3 giây.
- Lò xo nằm ở cạnh trên xuyên suốt.
- Không che vùng in bằng tay sau khi mở.
- Camera không zoom mạnh hoặc orbit quanh sản phẩm ở đoạn trang mở.

Nếu Muse vẫn tạo nội dung giả trên trang, compositor phải phủ kín toàn bộ vùng in được detect bằng artwork gốc. Không để lại text/illustration AI bên dưới hoặc lộ ở viền trong vùng in.

### 7.6. Worker/runtime và đóng gói

Không thêm native Node addon chưa được đánh giá tương thích Electron 45/Windows. Tách xử lý video thành adapter/worker để không khóa ứng dụng UI.

Trước khi chọn implementation cụ thể, làm một spike so sánh:

- OpenCV.js/WebAssembly hoặc implementation JS/WASM đã được kiểm duyệt.
- Worker sidecar được đóng gói cùng installer nếu cần OpenCV/FFmpeg native.

Nếu sử dụng sidecar:

- Không yêu cầu nhân viên cài Python/FFmpeg riêng.
- Đóng gói executable/runtime phiên bản pin cùng installer qua `electron-builder.yml` resources.
- Gọi process bằng `spawn(executable, args, { shell: false })`; không nối lệnh shell từ SKU/path/user input.
- Kiểm tra executable path nằm trong bundled resources đã cấu hình.
- Timeout, kill worker khi app thoát; dọn temp files.
- Kiểm tra license của OpenCV/FFmpeg build trước khi bundle; ghi rõ nguồn/version/license trong SBOM.
- Không mở network listener và không gửi video/artwork tới cloud compositor.

Không thêm SAM 2 hoặc model segmentation nặng làm dependency bắt buộc của MVP trước khi đo thử trên máy Windows mục tiêu.

### 7.7. Output và quality gate

- Processed MP4 phải được validate bằng `validateMp4Video()` trước `storeVideo()`.
- Giữ audio track gốc nếu có.
- Frame có tracking confidence thấp không được tạo ra artwork trôi/nhảy.
- Nếu trang không được detect đủ lâu, hoặc diện tích trang quá nhỏ/che khuất, trả lỗi post-process có safe message.
- Không âm thầm lưu video gốc có trang AI sai artwork như thể đã đạt yêu cầu Calendar.
- Dùng job state hiện tại `DOWNLOAD_FAILED` và action `retry_download` cho MVP; có thể bổ sung error code `CALENDAR_COMPOSITING_FAILED` nếu cần phân biệt trong UI.
- `retry_download` phải tải lại output từ cùng provider job rồi chạy lại compositor; không submit thêm generation job.

### 7.8. Metadata

Metadata final cần bổ sung (chỉ dữ liệu đã sanitize):

```json
{
  "calendarPostProcess": {
    "applied": true,
    "interiorArtworkSha256": "<sha256>",
    "compositorVersion": "<version>",
    "trackingCoverage": 0.0,
    "processedFrames": 0,
    "visibleFrames": 0
  }
}
```

Không ghi prompt text, API key, cookies, absolute paths, signed URLs hoặc raw image bytes vào log/metadata.

## 8. Prompt draft cho Calendar

### `prompts/master/calendar-review-v1.md`

```md
---
id: calendar-review
version: v1
title: Calendar product review (PLACEHOLDER)
placeholder: true
created_at: 2026-11-25
note: Draft calendar-specific template. Replace/approve through Prompt Master before production.
default: true
---

[PLACEHOLDER CALENDAR PROMPT — review and approve before production]

Create a realistic casual smartphone product review of a physical spiral-bound desk calendar.
SKU: {{sku}}
Category: {{product_category}}
Product Name: {{product_name}}
Review Style: {{review_style}}
Duration: {{duration_seconds}} seconds
Aspect Ratio: {{aspect_ratio}}

Scene & Action:
A real customer picks up the calendar, presents the exact front cover, naturally turns one page around the existing top spiral binding, and shows the inside page to the camera. The reviewer speaks naturally while handling the calendar.

Interior Page Requirement:
The interior page must be a clean, warm-cream, matte blank paper surface. Do not generate any text, calendar dates, numbers, symbols, illustrations, patterns, decorative artwork, logos, or fake printed details on the interior page. The original interior artwork will be composited locally after video generation. After turning the page, keep the interior page flat, unobstructed, front-facing, and visible for a stable inspection moment.

Rules:
1. Preserve the exact front-cover artwork, typography, colors, layout, and physical product identity.
2. Do not invent or alter any printed artwork.
3. Maintain one consistent physical desk calendar with the same landscape/portrait orientation, dimensions, paper construction, and top spiral binding shown in the reference.
4. Show realistic paper stiffness, page movement, gravity, and physically plausible handling.
5. Keep hands near the page edges; avoid covering the main printable area after the page is open.
6. Perform only one natural page turn. Do not rapidly flip through multiple pages.
7. Keep the opened page relatively flat and facing the camera for at least 2–3 seconds.
8. Use natural smartphone handheld footage, not a polished commercial.
9. Include authentic human review action and conversational spoken commentary.
10. Do not add fake claims, ratings, discounts, testimonials, subtitles, or promotional badges.

{{category_rules}}
```

### `prompts/categories/calendar.md`

```md
Calendar handling notes:
The product is a physical spiral-bound desk calendar. Preserve the exact physical format and binding position from the uploaded front-cover reference. The top spiral binding must stay at the top edge. The reviewer may pick up the calendar, present the front cover, and turn exactly one page naturally. The interior paper must remain blank, clean, matte, and free of AI-generated text or artwork because the original customer-supplied interior artwork will be composited locally after generation. Once opened, hold the page flat and front-facing long enough for local page tracking. Keep hands on the outer edges and away from the print area. Do not change page dimensions, orientation, binding, or product construction.
```

These drafts are starting points; keep `placeholder: true` until reviewed and approved by the company. Existing T-shirt Prompt Master remains unchanged.

## 9. Job creation and post-processing sequence

### 9.1. `createJob()` changes

Within `JobOrchestrator.createJob()`:

1. Validate `sourceToken` as today.
2. Resolve category.
3. If `category.promptGroup === 'calendar'`, require and resolve `interiorArtworkToken`.
4. Validate both images before importing.
5. Render/validate calendar template.
6. Check idempotency key before writing duplicate files, as current flow does.
7. Import front cover with `importSourceImage()`.
8. Import interior art with `importInteriorArtwork()`.
9. Write prompt snapshot.
10. In the existing single synchronous DB transaction, upsert product, insert source image asset, insert job, insert `interior_artwork` asset with `job_id = newJob.id`, and insert prompt snapshot asset.
11. On transaction failure, best-effort delete every file imported/written by this attempt.
12. Queue the job using the existing worker.

Do not `await` inside `db.transaction()`; current repository contract explicitly requires synchronous transaction callbacks.

### 9.2. `handleSubmit()` changes

No provider contract change. It continues to resolve `job.sourceAssetId` and pass only that front-cover path to `provider.generateVideo()`.

The interior artwork is never included in `GenerateVideoInput`.

### 9.3. `handleDownloading()` changes

1. Download original provider MP4 to temp path, as today.
2. Look up product category and associated `interior_artwork` asset.
3. If non-calendar: use current `media.storeVideo(tempPartPath, sku)` unchanged.
4. If calendar: resolve interior asset through `media.resolve()`, verify file exists and SHA-256, run CalendarArtworkCompositor into a second temp MP4.
5. Validate processed MP4, then call `media.storeVideo(processedTempPath, sku)`.
6. Write sanitized metadata including artwork hash and processing report.
7. Insert final `generated_video` asset and mark job `SUCCEEDED` using existing transaction.
8. Delete intermediate temp files in `finally` on success and failure.

If post-process fails, set the job to `DOWNLOAD_FAILED` with safe user-facing message and keep the provider job id so `retry_download` can download/process again. Do not call `generateVideo()` again.

### 9.4. `regenerate()` changes

Current regenerate creates a new job and reuses source/prompt assets. For a Calendar job, also insert a new `interior_artwork` asset row associated with the new job, pointing to the same stored relative path and SHA-256. Verify the source artwork still exists before creating the new job.

## 10. UI changes

### `src/renderer/src/screens/CreateVideo.tsx`

Add a second upload state and second dropzone, visible only when selected category has `promptGroup === 'calendar'`.

Keep current apparel dropzone unchanged.

Calendar form validation:

```ts
const isCalendar = selectedCategory?.promptGroup === 'calendar';
const isFormValid =
  frontCoverStaged !== null &&
  (!isCalendar || interiorArtworkStaged !== null) &&
  /* existing SKU/category/template/prompt/provider checks */;
```

`handleGenerate()` includes:

```ts
{
  sourceToken: frontCoverStaged.token,
  ...(isCalendar && interiorArtworkStaged
    ? { interiorArtworkToken: interiorArtworkStaged.token }
    : {})
}
```

Keep the existing one-click/single-flight/idempotency behavior.

### Preview and Library

- Create screen: preview both images separately.
- Queue: keep existing source thumbnail behavior; optionally show a small calendar indicator.
- Library: for Calendar jobs show Front Cover and Interior Artwork thumbnails alongside final video.
- Add optional `interiorArtworkUrl` to `JobView` if the UI needs a safe `pod-media://asset/<id>` URL. Do not expose absolute paths.

### i18n
Add labels in `src/renderer/src/i18n/en.ts` for Front Cover, Interior Artwork, remove/replace artwork, and calendar validation errors. Keep wording centralized.

## 11. Error handling and security

- Missing front cover → existing `INVALID_IMAGE`.
- Missing interior artwork for Calendar → a safe `INVALID_IMAGE` or new explicit local validation error; no provider request is submitted.
- Invalid/oversized interior artwork → existing image validation errors; no provider request is submitted.
- Missing persisted interior asset during post-process → safe `NOT_FOUND`/`DOWNLOAD_FAILED`; do not use an arbitrary file path.
- Hash mismatch → fail post-process; do not silently substitute a different artwork.
- Low tracking confidence → fail post-process; do not export a misaligned artwork as a successful result.
- Never log artwork content, image bytes, absolute paths, prompt text, API keys, cookies, or signed URLs.
- Worker uses validated internal temp/output paths and `spawn(..., { shell: false })` if an external process is used.
- Keep all app network listeners loopback-only; calendar compositing itself must make no network calls.
- Keep current secure preload/IPC boundary. Renderer must not access Node filesystem or launch processes.

## 12. Implementation work packages

### W-CAL-1 — Domain, config and category

- Add `calendar` to promptGroup types and Zod schemas.
- Add `desk-calendar` default category.
- Merge it into existing stored categories without overwriting custom categories.
- Tests: default config, legacy stored settings, Admin settings validation.

### W-CAL-2 — Calendar prompts

- Add `calendar-review-v1.md` and `categories/calendar.md`.
- Add category-aware template auto-selection in CreateVideo.
- Keep apparel template behavior unchanged.
- Tests: prompt loads, category snippet appended, placeholder checks, template switching.

### W-CAL-3 — Dual image upload and persistence

- Add second dropzone and `interiorArtworkToken` to IPC schema.
- Validate calendar requires two images.
- Add media import method and `interior_artwork` asset role.
- Add DB migration v2 and tests.
- Tests: artwork copied byte-identically, hash and dimensions stored, no duplicate import on idempotent request, transaction cleanup, regenerate reattaches artwork.

### W-CAL-4 — Local compositor proof of concept

Before wiring into the main queue, create a standalone test harness with 3–5 representative calendar videos.

Prove:
- Blank page can be detected in the generated video.
- Four corners can be found and tracked while page is held.
- Artwork stays within page boundary.
- Tracking confidence detects failures rather than producing obvious drift.
- Original audio survives the render.
- Runtime and memory are acceptable on target Windows hardware.

Do not proceed to production wiring if the proof of concept cannot reliably detect the opened page.

### W-CAL-5 — Orchestrator integration

- Add compositor interface/dependency.
- Apply processing only for calendar jobs in `handleDownloading()`.
- Preserve non-calendar download/store path byte-for-byte where possible.
- Keep retryDownload behavior and no duplicate Muse submit.
- Add metadata and safe error handling.

### W-CAL-6 — UI, Library and end-to-end tests

- Conditional two-image UI.
- Preview both images.
- Queue/Library indicators and artwork preview.
- E2E mock compositor path.
- Full regression tests for apparel.

## 13. Required automated tests

### Domain / config / prompts

- `Category.promptGroup === 'calendar'` accepted by shared and main config schemas.
- New installations include `desk-calendar`.
- Existing persisted custom categories are retained and `desk-calendar` is appended only if missing.
- Selecting Calendar automatically chooses `calendar-review`; selecting T-shirt preserves existing product-review selection.
- `calendar.md` is loaded by PromptService.
- Calendar prompt requires blank interior page and exact source artwork preservation.
- Existing apparel prompt tests continue to pass.

### UI / IPC

- Apparel still displays one dropzone and can generate with one image.
- Calendar displays two separate dropzones.
- Calendar Generate stays disabled until both images are staged.
- Calendar payload has `sourceToken` and `interiorArtworkToken`.
- Apparel payload omits `interiorArtworkToken`.
- Double click still creates exactly one job.
- Renderer never receives absolute paths.

### Media / DB

- Interior artwork validation rejects invalid signature, oversize byte size and oversize pixels.
- `importInteriorArtwork()` copies byte-identically and produces correct SHA-256.
- Migration v2 preserves all old `assets` rows and accepts `interior_artwork`.
- Job contains one source image asset and one job-linked interior artwork asset.
- Failed DB transaction removes newly imported source/artwork/prompt files.
- Regenerate reattaches the same interior artwork path/hash to the new job.

### Provider boundary

- Calendar job submits exactly one provider reference: front cover only.
- Interior artwork bytes/hash are never sent to Muse4AI/Muse bridge.
- Provider contract and endpoints are unchanged.
- Existing apparel mock-bridge tests pass unchanged.

### Post-processing

- Non-calendar output bypasses compositor completely.
- Calendar output calls compositor with the exact persisted artwork asset.
- Output MP4 validates before `storeVideo()`.
- Audio is preserved.
- Low tracking confidence fails safely; no falsely successful output.
- Retry download reuses the existing provider job and does not submit a second generation.
- Compositor failure does not leak temp files.
- Metadata records artwork SHA-256, compositor version and tracking metrics.

### Regression / security

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- Existing apparel happy path, retry, ambiguous-submit, idempotency and security tests remain green.
- Logs contain no image bytes, prompt contents, absolute paths or credentials.

## 14. MVP acceptance criteria

The Calendar feature is MVP-complete only when:

1. User chooses Desk Calendar and uploads front cover + interior artwork.
2. The app sends only the front cover through the existing Muse4AI → Muse.ai pipeline.
3. Muse-generated video shows a physically plausible calendar review and a blank interior page.
4. Local compositor places the exact user-supplied artwork onto the interior page after the page is visible.
5. Artwork does not drift outside the page during the stable open-page segment.
6. The final video retains audio and passes MP4 validation.
7. Source cover, original interior artwork, prompt snapshot, final video and metadata are stored under the SKU library.
8. A low-confidence tracking result is reported as a processing failure, not silently exported as a successful Calendar video.
9. Apparel workflow remains unchanged.
10. Employee experience is still one Generate action after uploading the two required images.

## 15. Explicit non-goals for first release

- Multiple inside pages/months in one job.
- Wall calendars, books, magazines, catalogues or arbitrary multi-page products.
- Fully realistic cloth-like bending of the calendar page.
- AI-generated replacement artwork.
- Uploading the second artwork as another Muse reference.
- Changing Muse4AI, provider endpoints, account/session handling or authentication.
- Replacing the current queue, database, SKU library, prompt service or security architecture.
- Cloud image processing or third-party video compositing APIs.

---

## 16. Delivery instruction to coding agent

Implement this as a **calendar-only extension** to the current POD Video Studio repository. Start with W-CAL-1 through W-CAL-3, then run the local compositor proof of concept before touching the production download pipeline. Reuse existing abstractions and test conventions. Do not refactor the apparel path. Do not change Muse4AI/provider contracts. If automatic page detection cannot meet the acceptance criteria on representative videos, stop and report the tracking limitation rather than shipping a compositor that visibly misaligns the artwork.
