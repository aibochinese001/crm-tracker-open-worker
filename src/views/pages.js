// 页面模板 - 使用 text import 避免嵌套模板字面量问题
import themeResourcesHtml from './theme-resources.html';
import loginPageHtml from './loginPage.html';
import adminPageHtml from './adminPage.html';
import configPageHtml from './configPage.html';
import dashboardPageHtml from './dashboardPage.html';
import notifyLogsPageHtml from './notifyLogsPage.html';
import usersPageHtml from './usersPage.html';
import userCenterPageHtml from './userCenterPage.html';
import plansPageHtml from './plansPage.html';
import payResultPageHtml from './payResultPage.html';
import myNotifyPageHtml from './myNotifyPage.html';
import adminOrdersPageHtml from './adminOrdersPage.html';

// themeResources 需要注入到每个页面模板中
function injectTheme(html) {
  return html.replace(/\$\{themeResources\}/g, themeResourcesHtml);
}

const loginPage = injectTheme(loginPageHtml);
const adminPage = injectTheme(adminPageHtml);
const configPage = injectTheme(configPageHtml);
const notifyLogsPage = injectTheme(notifyLogsPageHtml);
const usersPage = injectTheme(usersPageHtml);
const userCenterPage = injectTheme(userCenterPageHtml);
const plansPage = injectTheme(plansPageHtml);
const payResultPage = injectTheme(payResultPageHtml);
const myNotifyPage = injectTheme(myNotifyPageHtml);
const adminOrdersPage = injectTheme(adminOrdersPageHtml);

function dashboardPage() {
  return injectTheme(dashboardPageHtml);
}

export { loginPage, adminPage, configPage, dashboardPage, notifyLogsPage, usersPage, userCenterPage, plansPage, payResultPage, myNotifyPage, adminOrdersPage };
