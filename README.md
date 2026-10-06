# 定格动画拍摄帧序编排台（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量与拍摄参数记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、删除、移动帧并重算时长，随拍随记曝光参数与实拍张数。多机位场景下可建立**动作节拍**：主机位帧位上的动作锚点共享给各机位，挂接镜头按各自帧率换算帧位，主机位帧数变化时未拍机位立即重算、已拍机位保留原值待人工复核；两台设备可离线导出/导入节拍同步包，冲突两版并列、裁定前不动当前帧序。

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
        ├── types/{shot,frame,prop,take,beat}.ts     # 5 个数据模型
        ├── stores/{shotStore,frameStore,beatStore,uiStore}.ts
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState}.vue
        ├── hooks/{useFrameSequence,useProgress,useLocalDraft}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,BeatBoard,PropTrack,TakeLog}.vue
        ├── router/index.ts
        ├── utils/{frameMath,beatMath,exposure,format}.ts
        └── db/{index,api}.ts                      # Dexie 实例（v1→v4 升级迁移）与读写层
```

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 进度总览 | 各镜头状态、帧数、预计时长、完成百分比，累计全片张数与待拍张数 |
| `/shots/new` | 新建镜头 | 填写镜号、场景名、帧率与时长，保存后生成帧区间与首位帧条目 |
| `/shots/:id` | 镜头详情 | 镜头参数与进度、帧序条带、帧条目表格、多机位节拍、道具轨迹、登记实拍 |
| `/frames` | 帧序编排台 | 移动/插入/删除帧、批量套用曝光，改动后重算序号与总时长 |
| `/beats` | 多机位动作节拍 | 主机位锚点编排、机位挂接（≤6）与帧位换算、待复核裁定、离线合并 |
| `/props` | 道具位移轨迹 | 按镜头与帧区间登记 X/Y/Z 与旋转角度，曲线预览累计位移 |
| `/progress` | 实拍记录 | 登记当日实拍张数与废帧数，回写完成百分比并提示剩余张数 |

## 多机位动作节拍规则

- **节拍与锚点**：节拍以一个主机位镜头为基准，锚点记录主机位帧位上的动作时刻；换算采用时间点对齐 `副机位帧位 = 副机位起始帧 + (主机位帧位 − 主机位起始帧) ÷ 主机位帧率 × 副机位帧率`（四舍五入）。
- **挂接**：其他镜头挂接节拍后按各自帧率得到帧位，同一节拍最多 6 个机位（1 主机位 + 5 挂接）；主机位不可重复挂接。
- **主机位帧数一变**：时长 / 帧率 / 插删帧导致主机位帧区间变化后，以该镜头为主机位的全部节拍立即重算——**未拍**机位锚点帧位立即换算更新；**已拍**机位帧位保留原值，换算值写入「重算建议」并标记待复核，人工选择「采用重算」或「保留原值」。节拍只换算动作帧位，各镜头自己的帧区间/时长仍在帧序编排台各排各的。
- **离线合并**：在节拍台导出 JSON 同步包拷给另一台设备导入；本地没有的节拍按镜号重映射 id 后直接入库，同编号且有差异的节拍两版并列登记冲突（含挂接关系逐机位对照），**裁定前当前帧序保持本机版不动**。
- **失败恢复**：重算在单个 Dexie 事务内完成，失败自动回滚数据库并恢复动手前的 store 内存态；`shotStore` 层同步回退镜头本身的时长/帧区间改动。

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录、节拍、节拍冲突六张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；`v4` 增加 `beats` / `beatConflicts` 表，并把每个历史镜头派生为「单机位节拍」（主机位即镜头自身、无挂接机位、帧序保持原值）。
- **localStorage**：新建镜头表单、批量曝光参数草稿与本机设备标识（离线合并溯源），草稿键前缀 `gbstopmotion:draft:`，设备标识键 `gbstopmotion:device`。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
