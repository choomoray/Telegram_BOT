// utils/modeNames.js

const MODE_NAMES = {
    chat: '聊天模式',
    message_reply: '消息回复模式',
    search: '查找模式',
    delete: '数据删除模式',
    delete_group: '数据删除模式',
    clean: '数据库清理模式',
    mark: '标记模式',
    edit: '编辑模式',
    setting: '设置',
    transport: '搬运模式',
    password: '密码模式',
    manage: '管理模式',
    media_group: '媒体合并模式',
    media_hide: '媒体遮罩模式',
    media_unhide: '媒体去遮罩模式'
};

function getModeName(mode) {
    return MODE_NAMES[mode] || mode;
}

module.exports = { MODE_NAMES, getModeName };
