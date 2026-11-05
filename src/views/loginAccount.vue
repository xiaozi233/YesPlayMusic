<template>
  <div class="login">
    <div class="login-container">
      <div class="section-1">
        <img src="/img/logos/netease-music.png" />
      </div>
      <div class="title">{{ $t('login.loginText') }}</div>
      <div class="section-2">
        <div v-show="mode === 'phone'" class="input-box">
          <div
            class="container"
            :class="{ active: ['phone', 'countryCode'].includes(inputFocus) }"
          >
            <svg-icon icon-class="mobile" />
            <div class="inputs">
              <input
                id="countryCode"
                v-model="countryCode"
                :placeholder="
                  inputFocus === 'countryCode' ? '' : $t('login.countryCode')
                "
                @focus="inputFocus = 'countryCode'"
                @blur="inputFocus = ''"
                @keyup.enter="login"
              />
              <input
                id="phoneNumber"
                v-model="phoneNumber"
                :placeholder="inputFocus === 'phone' ? '' : $t('login.phone')"
                @focus="inputFocus = 'phone'"
                @blur="inputFocus = ''"
                @keyup.enter="login"
              />
            </div>
          </div>
        </div>

        <div v-show="mode === 'email'" class="input-box">
          <div class="container" :class="{ active: inputFocus === 'email' }">
            <svg-icon icon-class="mail" />
            <div class="inputs">
              <input
                id="email"
                v-model="email"
                type="email"
                :placeholder="inputFocus === 'email' ? '' : $t('login.email')"
                @focus="inputFocus = 'email'"
                @blur="inputFocus = ''"
                @keyup.enter="login"
              />
            </div>
          </div>
        </div>
        <div v-show="mode !== 'qrCode'" class="input-box">
          <div class="container" :class="{ active: inputFocus === 'password' }">
            <svg-icon icon-class="lock" />
            <div class="inputs">
              <input
                id="password"
                v-model="password"
                type="password"
                :placeholder="
                  inputFocus === 'password' ? '' : $t('login.password')
                "
                @focus="inputFocus = 'password'"
                @blur="inputFocus = ''"
                @keyup.enter="login"
              />
            </div>
          </div>
        </div>

        <div v-show="mode == 'qrCode'">
          <div v-show="qrCodeSvg" class="qr-code-container">
            <img :src="qrCodeSvg" loading="lazy" />
          </div>
          <div class="qr-code-info">
            {{ qrCodeInformation }}
          </div>
          <div v-show="qrCodeError" class="qr-code-error">
            <p v-html="qrCodeError"></p>
            <a class="retry" @click="getQrCodeKey">{{ $t('login.retry') }}</a>
          </div>
        </div>
      </div>
      <div v-show="mode !== 'qrCode'" class="confirm">
        <button v-show="!processing" @click="login">
          {{ $t('login.login') }}
        </button>
        <button v-show="processing" class="loading" disabled>
          <span></span>
          <span></span>
          <span></span>
        </button>
      </div>
      <div class="other-login">
        <a v-show="mode !== 'email'" @click="changeMode('email')">{{
          $t('login.loginWithEmail')
        }}</a>
        <span v-show="mode === 'qrCode'">|</span>
        <a v-show="mode !== 'phone'" @click="changeMode('phone')">{{
          $t('login.loginWithPhone')
        }}</a>
        <span v-show="mode !== 'qrCode'">|</span>
        <a v-show="mode !== 'qrCode'" @click="changeMode('qrCode')">
          二维码登录
        </a>
        <span>|</span>
        <a @click="showCookieLogin = !showCookieLogin">
          {{ $t('login.cookieLogin') }}
        </a>
      </div>
      <div v-show="showCookieLogin" class="cookie-login">
        <p class="cookie-tip" v-html="$t('login.cookieLoginTip')"></p>
        <textarea
          v-model="cookieInput"
          class="cookie-input"
          :placeholder="$t('login.cookiePlaceholder')"
          spellcheck="false"
        ></textarea>
        <button
          class="cookie-confirm"
          :disabled="cookieProcessing"
          @click="loginWithCookie"
        >
          {{ $t('login.cookieLoginButton') }}
        </button>
      </div>
      <div
        v-show="mode !== 'qrCode'"
        class="notice"
        v-html="isElectron ? $t('login.noticeElectron') : $t('login.notice')"
      ></div>
    </div>
  </div>
</template>

<script>
import QRCode from 'qrcode';
import md5 from 'crypto-js/md5';
import NProgress from 'nprogress';
import { mapMutations } from 'vuex';
import { setCookies, removeCookie } from '@/utils/auth';
import nativeAlert from '@/utils/nativeAlert';
import { userAccount } from '@/api/user';
import {
  loginWithPhone,
  loginWithEmail,
  loginQrCodeKey,
  loginQrCodeCheck,
} from '@/api/auth';

// 网易云风控拒绝登录时可能返回的错误码：
// -460 网络环境存在风险、-462 需要完成验证、8810/8821/8822 要求升级客户端或换登录方式。
// 旧版登录页只处理 800/801/802/803，这些错误会被静默忽略，表现为“扫码后一直卡住”。
const RISK_CONTROL_CODES = [-460, -462, 8810, 8821, 8822];

export default {
  name: 'Login',
  data() {
    return {
      processing: false,
      mode: 'qrCode',
      countryCode: '+86',
      phoneNumber: '',
      email: '',
      password: '',
      smsCode: '',
      inputFocus: '',
      qrCodeKey: '',
      qrCodeSvg: '',
      qrCodeError: '',
      qrCodeCheckInterval: null,
      qrCodeInformation: '打开网易云音乐APP扫码登录',
      showCookieLogin: false,
      cookieInput: '',
      cookieProcessing: false,
    };
  },
  computed: {
    isElectron() {
      return process.env.IS_ELECTRON;
    },
  },
  created() {
    if (['phone', 'email', 'qrCode'].includes(this.$route.query.mode)) {
      this.mode = this.$route.query.mode;
    }
    this.getQrCodeKey();
  },
  beforeDestroy() {
    clearInterval(this.qrCodeCheckInterval);
  },
  methods: {
    ...mapMutations(['updateData']),
    validatePhone() {
      if (
        this.countryCode === '' ||
        this.phone === '' ||
        this.password === ''
      ) {
        nativeAlert('国家区号或手机号不正确');
        this.processing = false;
        return false;
      }
      return true;
    },
    validateEmail() {
      const emailReg =
        /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
      if (
        this.email === '' ||
        this.password === '' ||
        !emailReg.test(this.email)
      ) {
        nativeAlert('邮箱不正确');
        return false;
      }
      return true;
    },
    login() {
      if (this.mode === 'phone') {
        this.processing = this.validatePhone();
        if (!this.processing) return;
        loginWithPhone({
          countrycode: this.countryCode.replace('+', '').replace(/\s/g, ''),
          phone: this.phoneNumber.replace(/\s/g, ''),
          password: 'fakePassword',
          md5_password: md5(this.password).toString(),
        })
          .then(this.handleLoginResponse)
          .catch(error => {
            this.processing = false;
            nativeAlert(`发生错误，请检查你的账号密码是否正确\n${error}`);
          });
      } else {
        this.processing = this.validateEmail();
        if (!this.processing) return;
        loginWithEmail({
          email: this.email.replace(/\s/g, ''),
          password: 'fakePassword',
          md5_password: md5(this.password).toString(),
        })
          .then(this.handleLoginResponse)
          .catch(error => {
            this.processing = false;
            nativeAlert(`发生错误，请检查你的账号密码是否正确\n${error}`);
          });
      }
    },
    handleLoginResponse(data) {
      if (!data) {
        this.processing = false;
        nativeAlert('发生错误，请稍后重试');
        return;
      }
      if (data.code === 200) {
        setCookies(data.cookie);
        this.finishLogin();
      } else {
        this.processing = false;
        if (RISK_CONTROL_CODES.includes(data.code)) {
          nativeAlert(this.$t('login.riskControlPlain', { code: data.code }));
        } else {
          nativeAlert(data.msg ?? data.message ?? '账号或密码错误，请检查');
        }
      }
    },
    finishLogin() {
      this.updateData({ key: 'loginMode', value: 'account' });
      this.$store.dispatch('fetchUserProfile').then(() => {
        this.$store.dispatch('fetchLikedPlaylist').then(() => {
          this.$router.push({ path: '/library' });
        });
      });
    },
    /**
     * 风控类错误统一处理：停止轮询，避免无意义地重复请求，
     * 并引导用户改用 Cookie 登录。
     */
    handleLoginError(code, fallbackMessage) {
      clearInterval(this.qrCodeCheckInterval);
      this.qrCodeKey = '';
      this.qrCodeSvg = '';
      if (RISK_CONTROL_CODES.includes(code)) {
        this.qrCodeError = this.$t('login.riskControl', { code });
        this.showCookieLogin = true;
      } else {
        this.qrCodeError = fallbackMessage || this.$t('login.loginFailed');
      }
      NProgress.done();
    },
    loginWithCookie() {
      const raw = this.cookieInput.trim();
      if (!raw || this.cookieProcessing) return;

      // 兼容两种粘贴方式：完整的 Cookie 头（MUSIC_U=xxx; __csrf=yyy）
      // 或者只粘贴 MUSIC_U 的值。
      const cookies = raw.includes('MUSIC_U')
        ? raw
            .split(/;\s*/)
            .map(item => item.trim())
            .filter(item => /^[^=\s]+=/.test(item))
        : [`MUSIC_U=${raw}`];

      if (!cookies.some(item => item.startsWith('MUSIC_U='))) {
        nativeAlert(this.$t('login.cookieInvalid'));
        return;
      }

      this.cookieProcessing = true;
      setCookies(cookies.join(';;'));
      userAccount()
        .then(result => {
          if (result?.code === 200 && result.profile) {
            this.cookieProcessing = false;
            this.finishLogin();
          } else {
            removeCookie('MUSIC_U');
            this.cookieProcessing = false;
            nativeAlert(this.$t('login.cookieInvalid'));
          }
        })
        .catch(() => {
          removeCookie('MUSIC_U');
          this.cookieProcessing = false;
          nativeAlert(this.$t('login.cookieInvalid'));
        });
    },
    getQrCodeKey() {
      clearInterval(this.qrCodeCheckInterval);
      this.qrCodeError = '';
      return loginQrCodeKey()
        .then(result => {
          if (!result) {
            this.handleLoginError(undefined, this.$t('login.loginFailed'));
            return;
          }
          if (result.code !== 200 || !result.data?.unikey) {
            this.handleLoginError(
              result.code,
              result.message ?? result.msg ?? this.$t('login.loginFailed')
            );
            return;
          }
          this.qrCodeKey = result.data.unikey;
          this.qrCodeInformation = '打开网易云音乐APP扫码登录';
          QRCode.toString(
            `https://music.163.com/login?codekey=${this.qrCodeKey}`,
            {
              width: 192,
              margin: 0,
              color: {
                dark: '#335eea',
                light: '#00000000',
              },
              type: 'svg',
            }
          )
            .then(svg => {
              this.qrCodeSvg = `data:image/svg+xml;utf8,${encodeURIComponent(
                svg
              )}`;
            })
            .catch(err => {
              console.error(err);
            })
            .finally(() => {
              NProgress.done();
            });
          this.checkQrCodeLogin();
        })
        .catch(error => {
          this.handleLoginError(
            undefined,
            `${this.$t('login.loginFailed')}\n${error}`
          );
        });
    },
    checkQrCodeLogin() {
      // 清除二维码检测
      clearInterval(this.qrCodeCheckInterval);
      this.qrCodeCheckInterval = setInterval(() => {
        if (this.qrCodeKey === '') return;
        loginQrCodeCheck(this.qrCodeKey)
          .then(result => {
            if (!result) return;
            if (result.code === 800) {
              this.getQrCodeKey(); // 重新生成QrCode
              this.qrCodeInformation = '二维码已失效，请重新扫码';
            } else if (result.code === 802) {
              this.qrCodeInformation = '扫描成功，请在手机上确认登录';
            } else if (result.code === 801) {
              this.qrCodeInformation = '打开网易云音乐APP扫码登录';
            } else if (result.code === 803) {
              clearInterval(this.qrCodeCheckInterval);
              this.qrCodeInformation = '登录成功，请稍等...';
              result.code = 200;
              result.cookie = (result.cookie ?? '').replaceAll(' HTTPOnly', '');
              this.handleLoginResponse(result);
            } else if (RISK_CONTROL_CODES.includes(result.code)) {
              this.handleLoginError(result.code, result.message ?? result.msg);
            }
          })
          .catch(() => {
            // 轮询期间的网络抖动不应中断登录流程
          });
      }, 1000);
    },
    changeMode(mode) {
      this.mode = mode;
      if (mode === 'qrCode') {
        this.checkQrCodeLogin();
      } else {
        clearInterval(this.qrCodeCheckInterval);
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.login {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin-top: 32px;
}

.login-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.title {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 48px;
  color: var(--color-text);
}

.section-1 {
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  img {
    height: 64px;
    margin: 20px;
    user-select: none;
  }
}

.section-2 {
  display: flex;
  align-items: center;
  flex-direction: column;
}

.input-box {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 16px;
  color: var(--color-text);

  .container {
    display: flex;
    align-items: center;
    height: 46px;
    background: var(--color-secondary-bg);
    border-radius: 8px;
    width: 300px;
  }

  .svg-icon {
    height: 18px;
    width: 18px;
    color: #aaaaaa;
    margin: {
      left: 12px;
      right: 6px;
    }
  }

  .inputs {
    display: flex;
    width: 85%;
  }

  input {
    font-size: 20px;
    border: none;
    background: transparent;
    width: 100%;
    font-weight: 600;
    margin-top: -1px;
    color: var(--color-text);
  }

  input::placeholder {
    color: var(--color-text);
    opacity: 0.38;
  }

  input#countryCode {
    flex: 3;
  }
  input#phoneNumber {
    flex: 12;
  }

  .active {
    background: var(--color-primary-bg);
    input,
    .svg-icon {
      color: var(--color-primary);
    }
  }
}

.confirm button {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 600;
  background-color: var(--color-primary-bg);
  color: var(--color-primary);
  border-radius: 8px;
  margin-top: 24px;
  transition: 0.2s;
  padding: 8px;
  width: 100%;
  width: 300px;
  &:hover {
    transform: scale(1.06);
  }
  &:active {
    transform: scale(0.94);
  }
}

.other-login {
  margin-top: 24px;
  font-size: 13px;
  color: var(--color-text);
  opacity: 0.68;
  a {
    padding: 0 8px;
  }
}

.notice {
  width: 300px;
  border-top: 1px solid rgba(128, 128, 128);
  margin-top: 48px;
  padding-top: 12px;
  font-size: 12px;
  color: var(--color-text);
  opacity: 0.48;
}

@keyframes loading {
  0% {
    opacity: 0.2;
  }
  20% {
    opacity: 1;
  }
  100% {
    opacity: 0.2;
  }
}

button.loading {
  height: 44px;
  cursor: unset;
  &:hover {
    transform: none;
  }
}
.loading span {
  width: 6px;
  height: 6px;
  background-color: var(--color-primary);
  border-radius: 50%;
  margin: 0 2px;
  animation: loading 1.4s infinite both;
}

.loading span:nth-child(2) {
  animation-delay: 0.2s;
}

.loading span:nth-child(3) {
  animation-delay: 0.4s;
}

.qr-code-container {
  background-color: var(--color-primary-bg);
  padding: 24px 24px 21px 24px;
  border-radius: 1.25rem;
  margin-bottom: 12px;
}
.qr-code-info {
  color: var(--color-text);
  text-align: center;
  margin-bottom: 28px;
}

.qr-code-error {
  max-width: 340px;
  margin: -12px auto 24px auto;
  padding: 12px 14px;
  border-radius: 8px;
  background: rgba(236, 65, 65, 0.08);
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.6;
  text-align: left;

  .retry {
    display: inline-block;
    margin-top: 8px;
    color: var(--color-primary);
    cursor: pointer;
  }
}

.cookie-login {
  width: 300px;
  margin-top: 20px;

  .cookie-tip {
    font-size: 12px;
    line-height: 1.6;
    color: var(--color-text);
    opacity: 0.68;
  }

  .cookie-input {
    box-sizing: border-box;
    width: 100%;
    height: 88px;
    margin-top: 8px;
    padding: 10px 12px;
    border: none;
    border-radius: 8px;
    outline: none;
    resize: none;
    font-size: 12px;
    font-family: inherit;
    color: var(--color-text);
    background: var(--color-secondary-bg);
  }

  .cookie-confirm {
    width: 100%;
    margin-top: 12px;
    padding: 10px;
    border-radius: 8px;
    font-size: 16px;
    font-weight: 600;
    color: var(--color-primary);
    background-color: var(--color-primary-bg);
    transition: 0.2s;

    &:hover:not(:disabled) {
      transform: scale(1.03);
    }

    &:disabled {
      opacity: 0.6;
      cursor: unset;
    }
  }
}
</style>
