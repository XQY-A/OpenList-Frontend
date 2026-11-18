# 个人 115 前端上游同步

`Sync Personal 115 Upstream` 仅通过 Actions 中的 Run workflow 手动触发，检查 `OpenListTeam/OpenList-Frontend/main`。选择个人 `custom/115` 分支，`main` 保留作上游对照。前后端上游同步及前端翻译同步的定时配置均已移除。

需要同步时先运行前端工作流，完成候选验证及需要的兼容性审查，再运行后端同名工作流更新固定前端版本。

工作流使用仓库自带的 `GITHUB_TOKEN` 创建候选分支和 PR，直接调用 `Personal 115 Build` 验证候选提交。相同输入产生相同提交，普通快进推送之前复核目标分支和候选 SHA，不强制覆盖已交付历史。

路径规则位于 `build-config/custom-115-sync.json`。普通说明及允许的翻译更新通过验证后自动接受；任务页面、类型、请求工具、共享组件、个人语言 overlay、依赖、构建、工作流，以及未知路径和删除都保留 PR 等待兼容性审查。文本冲突会跳过验证，保留上游候选供手工整合。上游新增本地个人规则和计划路径时，在推送前停止。

成功验证的候选提交会记录 `custom-115/frontend-validation` 状态。后端读取个人分支的完整 SHA 及精确提交的验证结果，更新固定前端版本后再构建、发布镜像；不需要额外 PAT 或跨仓库写权限。

首次配置需要将默认分支设为 `custom/115`，允许 Actions 创建 PR，并启用个人同步工作流以保留手动入口。继承的 `Sync i18n files` 工作流保持停用；个人构建继续使用固定语言包。

完整流程和审查要点见 [后端手动同步说明](https://github.com/XQY-A/OpenList/blob/custom/115/docs/development/custom-115-sync.md)。

同步行为测试使用临时 Git 仓库及模拟 API，不写入 GitHub：

```sh
python3 -B -m unittest discover -s tests -p 'test_sync_custom_115.py' -v
```
