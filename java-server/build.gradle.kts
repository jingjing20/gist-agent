plugins {
	java
	id("org.springframework.boot") version "3.5.5"
	id("io.spring.dependency-management") version "1.1.7"
}

group = "com.gistagent"
version = "1.0.0"

java {
	toolchain {
		languageVersion = JavaLanguageVersion.of(21)
	}
}

repositories {
	mavenCentral()
}

val springDotenvBom = "5.1.0"

dependencies {
	implementation(platform("me.paulschwarz:spring-dotenv-bom:$springDotenvBom"))
	developmentOnly(platform("me.paulschwarz:spring-dotenv-bom:$springDotenvBom"))
	developmentOnly("me.paulschwarz:springboot3-dotenv")
	developmentOnly("org.springframework.boot:spring-boot-devtools")

	implementation("org.springframework.boot:spring-boot-starter-web")
	implementation("org.springframework.boot:spring-boot-starter-jdbc")
	implementation("org.springframework.boot:spring-boot-starter-security")
	implementation("org.springframework.boot:spring-boot-starter-mail")
	implementation("org.springframework.boot:spring-boot-starter-validation")

	implementation("com.mysql:mysql-connector-j")

	implementation("com.openai:openai-java:4.32.0")

	implementation("com.opencsv:opencsv:5.9")
	implementation("org.apache.poi:poi:5.3.0")
	implementation("org.apache.poi:poi-ooxml:5.3.0")

	implementation("com.github.jsqlparser:jsqlparser:5.0")

	implementation("io.jsonwebtoken:jjwt-api:0.12.6")
	runtimeOnly("io.jsonwebtoken:jjwt-impl:0.12.6")
	runtimeOnly("io.jsonwebtoken:jjwt-jackson:0.12.6")

	annotationProcessor("org.springframework.boot:spring-boot-configuration-processor")

	testImplementation("org.springframework.boot:spring-boot-starter-test")
	testImplementation("org.springframework.security:spring-security-test")
	testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> {
	useJUnitPlatform()
}

tasks.withType<org.springframework.boot.gradle.tasks.run.BootRun> {
	environment(
		"SPRINGDOTENV_DIRECTORY",
		rootProject.projectDir.parentFile.absolutePath,
	)
}

tasks.withType<JavaCompile> {
	options.encoding = "UTF-8"
	options.compilerArgs.add("-parameters")
}
