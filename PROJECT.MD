# Nano Banana — Project Documentation

## 1) О проекте

`nano-banana` — это full-stack веб-приложение для генерации изображений на базе `gemini-3-pro-image-preview` с сохранением результатов в Supabase.

Ключевая идея продукта:
- быстро генерировать 1–4 изображения за запрос;
- работать с reference images (прикрепление/drag&drop/paste);
- хранить историю генераций в галерее;
- повторно использовать прошлые промпты, настройки и исходные референсы;
- показывать ориентировочную стоимость генераций.

---

## 2) Текущий стек

- **Frontend**: Next.js 15 (App Router), React, TypeScript
- **UI**: Tailwind CSS v4, shadcn/ui (частично), кастомные стили
- **Backend API**: Route Handler в `src/app/api/generate/route.ts`
- **AI**: Google Gemini API (`@google/genai`, модель `gemini-3-pro-image-preview`)
- **Database/Storage**: Supabase (Postgres + Storage)
- **Animations**: Framer Motion

---

## 3) Основные пользовательские сценарии

### Генерация
- Пользователь вводит prompt.
- Выбирает:
  - `Aspect Ratio`
  - `Quality` (`1K`, `2K`, `4K`)
  - `Count` (`1..4`)
- Прикрепляет до 4 reference images.
- Нажимает `Generate` или `Cmd/Ctrl + Enter`.

### Во время генерации
- В галерее сверху появляются skeleton-карточки.
- Параллельные генерации разрешены (можно запускать новые, пока старые не завершились).
- Pending-состояние сохраняется и переживает перезагрузку страницы (с TTL).

### После генерации
- Новые изображения добавляются в галерею.
- Открывается модалка с деталями по клику на карточку.
- Кнопка Copy на карточке переносит prompt + настройки + исходные референсы в островок.

---

## 4) Архитектура

### Frontend
- Главная страница: `src/app/page.tsx`
- Основные зоны:
  - Top navbar (`Nano Banana Pro`, total spent)
  - Галерея изображений
  - Input island (fixed снизу)
  - Модалка деталей изображения

### Backend
- Endpoint: `POST /api/generate`
- Файл: `src/app/api/generate/route.ts`
- Ответ: `{ results: [...] }`

### Supabase
- Таблица: `public.generated_images`
- Бакет: `generated-images`

---

## 5) Данные и схема БД

### Базовые данные генерации
- `prompt`
- `aspect_ratio`
- `storage_path`
- `public_url`

### Метаданные генерации
- `quality`
- `requested_count`
- `reference_images` (jsonb)

### Стоимость (estimated)
- `estimated_cost_usd`
- `currency`
- `model`
- `pricing_version`

### Миграции в проекте
- `supabase/migrations/20260320_add_aspect_ratio_to_generated_images.sql`
- `supabase/migrations/20260320120000_add_generation_metadata_to_generated_images.sql`
- `supabase/migrations/20260320143000_add_cost_tracking_to_generated_images.sql`

---

## 6) Локальное хранение (черновики и состояние)

### Черновик островка
- Ключ: `nano-banana:island-draft`
- TTL: 30 дней
- Содержит:
  - prompt
  - aspectRatio
  - quality
  - count
  - references (data URLs)
  - updatedAt

### IndexedDB для референсов
- DB: `nano-banana-db`
- Store: `drafts`
- Key: `island-draft-v2`
- Нужен для стабильного хранения reference images (избегаем лимитов `localStorage`).

### Pending-генерации
- Ключ: `nano-banana:pending-generations:v1`
- TTL: 15 минут
- Нужен, чтобы скелетоны не исчезали после перезагрузки во время активной генерации.

### Local metadata fallback
- Ключ: `nano-banana:generation-meta:v1`
- Используется как fallback, если часть колонок временно недоступна в БД.

---

## 7) API-контракт (`/api/generate`)

### Request body
- `prompt: string`
- `aspectRatio: string`
- `quality: string`
- `count: number`
- `referenceImages: { mimeType: string; data: string }[]`

### Response body
- `results: Array<{`
  - `id: string`
  - `prompt: string`
  - `public_url: string`
  - `aspectRatio: string`
  - `quality: string`
  - `count: number`
  - `referenceImages: { mimeType: string; data: string }[]`
  - `estimatedCostUsd: number`
  - `currency: string`
  - `model: string`
  - `pricingVersion: string`
- `}>`

### Поведение
- Генерирует `count` изображений параллельно.
- Загружает каждый файл в Supabase Storage.
- Сохраняет запись в `generated_images`.
- При ошибках возвращает `500` с `{ error }`.

---

## 8) Стоимость генерации

Стоимость в UI — **оценочная** (`estimated`), считается на сервере:

- Base:
  - `1K = 0.02 USD`
  - `2K = 0.04 USD`
  - `4K = 0.08 USD`
- Дополнительно:
  - `+ 0.0025 USD` за каждый reference (до 4)

Поля стоимости пишутся в БД и используются для `Total spent`.

---

## 9) UI/UX детали

### Галерея
- Сейчас отображается как `grid` (хронологический порядок важнее masonry-эстетики).
- Сортировка: новые сверху (по `created_at DESC`, плюс клиентская досортировка).

### Skeleton loading
- Появляются сразу после старта генерации.
- Привязаны к `aspect ratio` соответствующего запроса.

### Модалка
- Анимирована через Framer Motion (`AnimatePresence` + spring).
- Показывает детали изображения:
  - prompt, ratio, quality, count, refs, cost, model, id, created, public URL

### Input island
- 3 ряда:
  1) Референсы
  2) Текст
  3) Настройки + Generate
- Анимированная градиентная обводка (фиолетовый/розовый/красный).
- Кнопка Generate с градиентом и glow при генерации.
- Hotkey-подсказка `⌘ Enter`.

---

## 10) Переменные окружения

Требуются в `.env.local`:

- `GEMINI_API_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Примечания:
- На клиенте используется anon key.
- На сервере для Storage/insert используется service role key (`supabaseAdmin`).

---

## 11) Важные файлы

- `src/app/page.tsx` — основной UI/логика страницы
- `src/app/api/generate/route.ts` — серверная генерация и запись
- `lib/supabase.ts` — инициализация supabase/supabaseAdmin
- `src/lib/supabase.ts` — реэкспорт
- `src/app/globals.css` — глобальная тема и стили
- `supabase/migrations/*.sql` — миграции схемы

---

## 12) Как запустить

```bash
npm install
npm run dev
```

Открыть:
- `http://localhost:3000`

---

## 13) Известные ограничения

- Оценка стоимости не является официальным billing-ответом API.
- Большие data URL референсов могут нагружать браузерную память.
- Много логики находится в одном файле `page.tsx` (технический долг на рефакторинг).

---

## 14) План улучшений (рекомендуется)

- Разделить `page.tsx` на модули:
  - hooks (`useIslandDraft`, `useGallery`, `useGenerationQueue`)
  - UI components (`Gallery`, `Island`, `ImageDetailsModal`)
- Добавить e2e-тесты ключевых сценариев.
- Добавить явный индикатор статуса сохранения черновика.
- Добавить pagination/virtualization галереи для очень больших объёмов.
- Вынести тарифы в централизованный конфиг/таблицу.

---

## 15) Правило ведения документации

С этого момента **вся проектная документация ведётся в `PROJECT.MD`**:
- новые фичи;
- изменения API/схемы;
- миграции;
- архитектурные решения;
- known issues и roadmap.
