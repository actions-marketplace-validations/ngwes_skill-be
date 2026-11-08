# [1.5.0](https://github.com/ngwes/skill-be/compare/v1.4.1...v1.5.0) (2026-11-07)


### Features

* restyle the html report after the skill-be style guide ([0102394](https://github.com/ngwes/skill-be/commit/01023944aea425808cc77ba2e6a43adb2acedb8d))

## [1.4.1](https://github.com/ngwes/skill-be/compare/v1.4.0...v1.4.1) (2026-11-07)


### Bug Fixes

* say no grading happened when no scenario has criteria ([8fe84d1](https://github.com/ngwes/skill-be/commit/8fe84d1cbccaa5c0236a3454a1b6f62a83eccb5e))

# [1.4.0](https://github.com/ngwes/skill-be/compare/v1.3.0...v1.4.0) (2026-11-07)


### Bug Fixes

* allow Windows variables in any case and keep the child's own exit ([c050da5](https://github.com/ngwes/skill-be/commit/c050da5f2448cc8452e9b106fbbce152a294b141))
* ignore short identifiers in a derived contract vocabulary ([bb13244](https://github.com/ngwes/skill-be/commit/bb13244eb676a758aca389ba59fa7420c3de46e1))
* install test packages in a clean folder, with file: specs and the project's .npmrc ([0062bb1](https://github.com/ngwes/skill-be/commit/0062bb199856d6bfeca022a551674b898eb8f0f9))
* keep the test registry out of the public testing api ([363f7d1](https://github.com/ngwes/skill-be/commit/363f7d1594a61e9b2ea1cc0051f2da06307b664c))
* name code test errors in the gate's error reason ([1d134be](https://github.com/ngwes/skill-be/commit/1d134be9d1da8ad1a0e435e6c54f441f434fffd3))
* pass file:// url specs in a package list through as urls ([88e90df](https://github.com/ngwes/skill-be/commit/88e90df1cae3c8a3230ec5322a0b125cd8993e21))
* reject a test file that registers no tests ([2d5da85](https://github.com/ngwes/skill-be/commit/2d5da85a4606df1a9384b491ae9983177e87969e))
* validate the code tests' package lists in check ([61caf43](https://github.com/ngwes/skill-be/commit/61caf43580cd7d77db154e99d2d12a4bf9431b2e))
* warn instead of failing when a code tests folder cannot be removed ([2bab854](https://github.com/ngwes/skill-be/commit/2bab8541f6842cd5fba785da5f03739c0a6a8e06))


### Features

* add config keys for code tests ([9ac33e7](https://github.com/ngwes/skill-be/commit/9ac33e7ce8d312c68bc01981d8237d69bfce83ed))
* add the test wrapper and transpile answers and tests ([d0062a8](https://github.com/ngwes/skill-be/commit/d0062a804ed29b5f716905f68a3142e890c9442b))
* append the output contract to both arms' prompts ([38f8d18](https://github.com/ngwes/skill-be/commit/38f8d180ffbd748f577be9630dde80ba55818bad))
* find code tests by convention and fingerprint them ([21b7469](https://github.com/ngwes/skill-be/commit/21b746941d4a15bb8ea978e64b97e04d23e6c419))
* install the package lists of code tests ([b1b47dc](https://github.com/ngwes/skill-be/commit/b1b47dcdd06d5b175342eaf39ebc4faf72e335bb))
* parse output contracts and optional criteria in eval files ([4f95d73](https://github.com/ngwes/skill-be/commit/4f95d739cd0407dfddcaf11da59751e6deccfb12))
* prepare code tests before a run ([5828871](https://github.com/ngwes/skill-be/commit/5828871830e0314329a1df351741fd66f90bdd03))
* run an answer's tests in a child process ([a68b330](https://github.com/ngwes/skill-be/commit/a68b33085b4912c14ec3d7b9dc43bee263fefead))
* run and check code tests from the cli ([f1941f2](https://github.com/ngwes/skill-be/commit/f1941f2be310f5f807982114731a05829bc0ee15))
* score code tests like criteria in the gate and reports ([12e7bcf](https://github.com/ngwes/skill-be/commit/12e7bcf9ce392c2c5f876d2bdba8ffcf22752006))
* triage failing code tests ([2bebe4f](https://github.com/ngwes/skill-be/commit/2bebe4f350ba4baca160733acc8c9c8e1ebc3ddc))
* warn when an output contract names the skill's vocabulary ([045b07d](https://github.com/ngwes/skill-be/commit/045b07da5b7cf3d3bf1bea5cd94bee37c4ad5f5d))

# [1.3.0](https://github.com/ngwes/skill-be/compare/v1.2.0...v1.3.0) (2026-11-03)


### Features

* add a github action that runs skill-be verify ([81afa21](https://github.com/ngwes/skill-be/commit/81afa2159c55dc7e19a9a0f463cc0e3b72a47c06))

# [1.2.0](https://github.com/ngwes/skill-be/compare/v1.1.0...v1.2.0) (2026-11-02)


### Features

* write the run as an html page with run --html ([8b01a7e](https://github.com/ngwes/skill-be/commit/8b01a7e8a736bc64f219f769aafd23f2d088c668))

# [1.1.0](https://github.com/ngwes/skill-be/compare/v1.0.2...v1.1.0) (2026-11-01)


### Features

* explain that skill-be is short for skill benchmark ([a4ab42a](https://github.com/ngwes/skill-be/commit/a4ab42a4eae78c7c565cfff8228cc85ea45e055b))

## [1.0.2](https://github.com/ngwes/skill-be/compare/v1.0.1...v1.0.2) (2026-10-31)


### Bug Fixes

* **claude-cli:** run claude in an empty temp directory, out of the project's git context ([38fab35](https://github.com/ngwes/skill-be/commit/38fab3531626ac3bd318ab5c8b104e3a8e6c1575))

## [1.0.1](https://github.com/ngwes/skill-be/compare/v1.0.0...v1.0.1) (2026-10-31)


### Bug Fixes

* word the grader, triage and report text for skills without code ([a94d298](https://github.com/ngwes/skill-be/commit/a94d298c549d4dc89d3d5ed3d735c1a7245e8dc2))

# 1.0.0 (2026-10-31)


### Features

* initial implementation ([c6c9530](https://github.com/ngwes/skill-be/commit/c6c95308e070887c53127db512ac52ccc14dbc2e))
