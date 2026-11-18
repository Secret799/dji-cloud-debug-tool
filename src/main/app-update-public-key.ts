/**
 * 更新清单验签公钥（Ed25519）。
 *
 * 私钥只存放于 GitHub Actions Secret ，发布流程用它签名
 * latest.json；应用用它校验清单，再按清单里的 SHA-256 校验安装包。
 */
export const APP_UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAOhOK5B6BpI19xIUYLNBlLHWag25XRVSeZDrkrkkw3BY=
-----END PUBLIC KEY-----`
