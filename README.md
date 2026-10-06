# 定格动画拍摄帧序编排台（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量与拍摄参数记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、删除、移动帧并重算时长，随拍随记曝光参数与实拍张数。多机位场景下，多个镜头共用**动作节拍**：以主机位帧号为时间基准，挂接其他镜头后按各自帧率换算帧位；主机位帧数一变，未拍镜头立即重算，已拍镜头保留原值待复核。

## 多机位动作节拍

- **共用节拍、各拍各的**：节拍以「主机位帧号」为动作时间基准；其他镜头挂接后按 `(主机位帧−1)/主机位帧率 × 本镜头帧率 + 1` 换算本镜头帧位。同一节拍最多挂 **6 个机位**（含主机位）。
- **主机位帧变联动**：主机位改时长/帧率或增删帧导致帧数变化时，**未拍**镜头立即采用换算后的新帧位；**已拍**镜头保留原帧位，换算结果作为建议值进入待复核，可在「动作节拍」页或镜头详情面板逐条「采纳新值 / 保留原值」。
- **离线合并**：导出本机节拍包（JSON）拷到另一台设备并入。节拍与挂接用稳定 uuid 匹配、镜号匹配镜头；节拍字段、主机位帧号、挂接帧位、挂接增减、机位超限、镜头缺失等**冲突两版并列**，确认前一律保持本机当前帧序不变。
- **失败安全**：联动重算在单次写入内提交，失败即恢复动手前记录，并把涉及节拍降级为**单机位节拍（legacy）**脱离联动、数据保留待人工处理。
- **历史数据**：IndexedDB 升级到 `v4` 时，为每个已有镜头生成一条落在首帧的单机位节拍；可在节拍页一键重新纳入多机位联动。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21830>

停止（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 + `vue-tsc -b`（类型检查零错误） |
| 状态 | Pinia（`shotStore` / `frameStore` / `beatStore` / `uiStore`） |
| 路由 | Vue Router 4（HTML5 History，nginx `try_files` 兜底） |
| UI | Element Plus + 自研轻量组件 |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（多阶段构建，gzip + 前端路由回落） |

## 目录结构

```
sologsb-1130/
├── docker-compose.yml        # 顶层 name: gbstopmotion，端口 ${FRONTEND_PORT:-21830}
├── .env / .env.example       # COMPOSE_PROJECT_NAME=gbstopmotion
└── frontend/
    ├── Dockerfile            # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files $uri $uri/ /index.html + gzip
    ├── public/favicon.svg
    └── src/
        ├── types/{shot,frame,prop,take,beat}.ts        # 5 个数据模型（beat=动作节拍/合并冲突）
        ├── stores/{shotStore,frameStore,beatStore,uiStore}.ts
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState,ShotBeatPanel}.vue
        ├── hooks/{useFrameSequence,useProgress,useLocalDraft}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,BeatSync,PropTrack,TakeLog}.vue
        ├── router/index.ts
        ├── utils/{frameMath,beatMath,beatMerge,exposure,format}.ts
        └── db/{index,api}.ts                      # Dexie 实例（v1→v4 升级迁移）与读写层
```

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 进度总览 | 各镜头状态、帧数、预计时长、完成百分比，累计全片张数与待拍张数 |
| `/shots/new` | 新建镜头 | 填写镜号、场景名、帧率与时长，保存后生成帧区间与首位帧条目 |
| `/shots/:id` | 镜头详情 | 镜头参数与进度、帧序条带、帧条目表格、道具轨迹、登记实拍 |
| `/frames` | 帧序编排台 | 移动/插入/删除帧、批量套用曝光，改动后重算序号与总时长 |
| `/beats` | 动作节拍 | 多机位节拍编排、机位挂接（≤6）、已拍帧位复核、离线节拍包导入导出与冲突确认 |
| `/props` | 道具位移轨迹 | 按镜头与帧区间登记 X/Y/Z 与旋转角度，曲线预览累计位移 |
| `/progress` | 实拍记录 | 登记当日实拍张数与废帧数，回写完成百分比并提示剩余张数 |

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录、动作节拍五张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；`v4` 增加 `beats` 表（按稳定 `uuid` / 主机位镜号匹配），并为每个历史镜头生成一条单机位节拍（legacy）。
- **localStorage**：新建镜头表单与批量曝光参数草稿，键前缀 `gbstopmotion:draft:`。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
