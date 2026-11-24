plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val runNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "io.github.alloong.soundmesh"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.alloong.soundmesh"
        minSdk = 29          // Android 10：抓其他 App 声音的最低版本
        targetSdk = 34
        versionCode = runNumber
        versionName = "0.1.$runNumber"
    }

    // 固定的签名：每次自动打包出来的 App 签名一样，可以直接覆盖安装更新
    signingConfigs {
        create("shared") {
            storeFile = file("soundmesh.keystore")
            storePassword = "soundmesh"
            keyAlias = "soundmesh"
            keyPassword = "soundmesh"
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("shared")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}
