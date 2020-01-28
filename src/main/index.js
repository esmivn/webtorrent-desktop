console.time('init')

const electron = require('electron')
const app = electron.app

const parallel = require('run-parallel')
const request = require('request')
const createTorrent = require('create-torrent')
const parseTorrent = require('parse-torrent')
const git = require('simple-git')
const gitp = require('simple-git/promise')
const CryptoJS = require("crypto-js")
const async = require('async')
const path = require('path')
const fs = require('fs')

const config = require('../config')
const crashReporter = require('../crash-reporter')
const ipc = require('./ipc')
const log = require('./log')
const menu = require('./menu')
const State = require('../renderer/lib/state')
const windows = require('./windows')
const AWS = require('aws-sdk');

const WEBTORRENT_VERSION = require('webtorrent/package.json').version
const JavaScriptObfuscator = require('javascript-obfuscator');

let shouldQuit = false
let argv = sliceArgv(process.argv)

// allow electron/chromium to play startup sounds (without user interaction)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Start the app without showing the main window when auto launching on login
// (On Windows and Linux, we get a flag. On MacOS, we get special API.)
const hidden = argv.includes('--hidden') ||
  (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden)

if (config.IS_PRODUCTION) {
  // When Electron is running in production mode (packaged app), then run React
  // in production mode too.
  process.env.NODE_ENV = 'production'
}

if (process.platform === 'win32') {
  const squirrelWin32 = require('./squirrel-win32')
  shouldQuit = squirrelWin32.handleEvent(argv[0])
  argv = argv.filter((arg) => !arg.includes('--squirrel'))
}

if (!shouldQuit && !config.IS_PORTABLE) {
  // Prevent multiple instances of app from running at same time. New instances
  // signal this instance and quit. Note: This feature creates a lock file in
  // %APPDATA%\Roaming\WebTorrent so we do not do it for the Portable App since
  // we want to be "silent" as well as "portable".
  if (!app.requestSingleInstanceLock()) {
    shouldQuit = true
  }
}

if (shouldQuit) {
  app.quit()
} else {
  init()
}

function init () {
  app.on('second-instance', (event, commandLine, workingDirectory) => onAppOpen(commandLine))
  if (config.IS_PORTABLE) {
    const path = require('path')
    // Put all user data into the "Portable Settings" folder
    app.setPath('userData', config.CONFIG_PATH)
    // Put Electron crash files, etc. into the "Portable Settings\Temp" folder
    app.setPath('temp', path.join(config.CONFIG_PATH, 'Temp'))
  }

  const ipcMain = electron.ipcMain

  let isReady = false // app ready, windows can be created
  app.ipcReady = false // main window has finished loading and IPC is ready
  app.isQuitting = false

  parallel({
    appReady: (cb) => app.on('ready', () => cb(null)),
    state: (cb) => State.load(cb)
  }, onReady)

  function onReady (err, results) {
    if (err) throw err

    isReady = true
    const state = results.state

    windows.main.init(state, { hidden: hidden })
    windows.webtorrent.init()
    menu.init()

    // To keep app startup fast, some code is delayed.
    setTimeout(() => {
      delayedInit(state)
    }, config.DELAYED_INIT)

    // Report uncaught exceptions
    process.on('uncaughtException', (err) => {
      console.error(err)
      const error = { message: err.message, stack: err.stack }
      windows.main.dispatch('uncaughtError', 'main', error)
    })
  }

  // Enable app logging into default directory, i.e. /Library/Logs/WebTorrent
  // on Mac, %APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config on Linux.
  app.setAppLogsPath()

  app.userAgentFallback = `WebTorrent/${WEBTORRENT_VERSION} (https://webtorrent.io)`

  app.on('open-file', onOpen)
  app.on('open-url', onOpen)

  ipc.init()

  app.once('will-finish-launching', function () {
    crashReporter.init()
  })

  app.once('ipcReady', function () {
    log('Command line args:', argv)
    processArgv(argv)
    console.timeEnd('init')
  })

  app.on('before-quit', function (e) {
    if (app.isQuitting) return

    app.isQuitting = true
    e.preventDefault()
    windows.main.dispatch('stateSaveImmediate') // try to save state on exit
    ipcMain.once('stateSaved', () => app.quit())
    setTimeout(() => {
      console.error('Saving state took too long. Quitting.')
      app.quit()
    }, 4000) // quit after 4 secs, at most
  })

  app.on('activate', function () {
    if (isReady) windows.main.show()
  })

  setInterval(torrentsUpdater, 30 * 1000)
  fastTest();
}

function delayedInit (state) {
  if (app.isQuitting) return

  const announcement = require('./announcement')
  const dock = require('./dock')
  const updater = require('./updater')
  const FolderWatcher = require('./folder-watcher')
  const folderWatcher = new FolderWatcher({ window: windows.main, state })

  announcement.init()
  dock.init()
  updater.init()

  ipc.setModule('folderWatcher', folderWatcher)
  if (folderWatcher.isEnabled()) {
    folderWatcher.start()
  }

  if (process.platform === 'win32') {
    const userTasks = require('./user-tasks')
    userTasks.init()
  }

  if (process.platform !== 'darwin') {
    const tray = require('./tray')
    tray.init()
  }
}

function onOpen (e, torrentId) {
  e.preventDefault()

  if (app.ipcReady) {
    // Magnet links opened from Chrome won't focus the app without a setTimeout.
    // The confirmation dialog Chrome shows causes Chrome to steal back the focus.
    // Electron issue: https://github.com/atom/electron/issues/4338
    setTimeout(() => windows.main.show(), 100)

    processArgv([torrentId])
  } else {
    argv.push(torrentId)
  }
}

function onAppOpen (newArgv) {
  newArgv = sliceArgv(newArgv)

  if (app.ipcReady) {
    log('Second app instance opened, but was prevented:', newArgv)
    windows.main.show()

    processArgv(newArgv)
  } else {
    argv.push(...newArgv)
  }
}

// Remove leading args.
// Production: 1 arg, eg: /Applications/WebTorrent.app/Contents/MacOS/WebTorrent
// Development: 2 args, eg: electron .
// Test: 4 args, eg: electron -r .../mocks.js .
function sliceArgv (argv) {
  return argv.slice(config.IS_PRODUCTION ? 1
    : config.IS_TEST ? 4
      : 2)
}

function processArgv (argv) {
  const torrentIds = []
  argv.forEach(function (arg) {
    if (arg === '-n' || arg === '-o' || arg === '-u') {
      // Critical path: Only load the 'dialog' package if it is needed
      const dialog = require('./dialog')
      if (arg === '-n') {
        dialog.openSeedDirectory()
      } else if (arg === '-o') {
        dialog.openTorrentFile()
      } else if (arg === '-u') {
        dialog.openTorrentAddress()
      }
    } else if (arg === '--hidden') {
      // Ignore hidden argument, already being handled
    } else if (arg.startsWith('-psn')) {
      // Ignore Mac launchd "process serial number" argument
      // Issue: https://github.com/webtorrent/webtorrent-desktop/issues/214
    } else if (arg.startsWith('--')) {
      // Ignore Spectron flags
    } else if (arg === 'data:,') {
      // Ignore weird Spectron argument
    } else if (arg !== '.') {
      // Ignore '.' argument, which gets misinterpreted as a torrent id, when a
      // development copy of WebTorrent is started while a production version is
      // running.
      torrentIds.push(arg)
    }
  })
  if (torrentIds.length > 0) {
    windows.main.dispatch('onOpen', torrentIds)
  }
}

function getContentTypeByFile(fileName) {
  var rc = 'application/octet-stream';
  var fn = fileName.toLowerCase();
  if (fn.indexOf('.html') >= 0) rc = 'text/html';
  else if (fn.indexOf('.htm') >= 0) rc = 'text/html';
  else if (fn.indexOf('.css') >= 0) rc = 'text/css';
  else if (fn.indexOf('.json') >= 0) rc = 'application/json';
  else if (fn.indexOf('.js') >= 0) rc = 'application/x-javascript';
  else if (fn.indexOf('.png') >= 0) rc = 'image/png';
  else if (fn.indexOf('.jpg') >= 0) rc = 'image/jpg';
  else if (fn.indexOf('.jpeg') >= 0) rc = 'image/jpg';
  return rc;
}

// Initializing S3 Interface
const s3 = new AWS.S3({
    accessKeyId: config.AWS_API_KEY,
    secretAccessKey: config.AWS_API_SECRET
});

const uploadFile = (filePath, callback) => {
    // read content from the file
    const fileContent = fs.readFileSync(filePath);

    // setting up s3 upload parameters
    const params = {
        Bucket: config.AWS_API_S3BUCKET,
        Key: path.basename(filePath),
        Body: fileContent,
        ContentType: getContentTypeByFile(filePath)
    };

    // Uploading files to the bucket
    s3.upload(params, function(err, data) {
        if (err) {
            throw err
        }
        console.log(`File uploaded successfully. ${data.Location}`)
        if (callback)
          callback(data.Location)
    });
};

function downloadFile (sourceUrl, targetFilePath, callback) {
  const file = fs.createWriteStream(targetFilePath);
  const sendReq = request.get(sourceUrl);

  // verify response code
  sendReq.on('response', (response) => {
      if (response.statusCode !== 200) {
          return console.error('Response status was ' + response.statusCode);
      }

      sendReq.pipe(file);
  });

  // close() is async, call cb after close completes
  file.on('finish', () => {
    file.close();
    if (fs.existsSync(targetFilePath))
      callback(targetFilePath);
  });

  // check for request errors
  sendReq.on('error', (err) => {
      fs.unlink(targetFilePath, function (err) {
          if (!err) console.log('File deleted!');
      });
      console.error(err.message);
  });

  file.on('error', (err) => { // Handle errors
      fs.unlink(targetFilePath, function (err) {
          if (!err) console.log('File deleted!');
      });
      console.error(err.message);
  });
};

function automationServer (port) {
    var protocal = "http";
    var domain = config.SERVER_DOMAIN;
    port = port ? port : config.SERVER_PORT;
    return {
        BaseUrl: protocal + "://" + domain + ":" + port + "/"
    };
};

function getGitFileUrl (fileName) {
  return "https://raw.githubusercontent.com/" + config.GIT_USER_NAME + "/" + config.GIT_REPO_NAME + "/master/" + fileName;
}

function getTorrentAndSeed () {
  request.get({
      url: automationServer().BaseUrl + 'api/Seed',
      json: true,
      headers: {'User-Agent': 'request'}
    }, (err, res, data) => {
      if (err) {
        console.log('Error:', err);
      } else if (res.statusCode !== 200) {
        console.log('Status:', res.statusCode);
      } else {
        // data is already parsed as JSON:
        for (var i = 0; i < data.length; i++) {
          var torrentInfo = data[i];
          var torrentFullPath = path.join(config.SEEDING_TORRENTS_PATH, torrentInfo.id + ".torrent");
          if (!fs.existsSync(torrentFullPath)) {
            downloadFile(torrentInfo.torrentUrl, torrentFullPath, function (fp) {
              windows.main.dispatch('addTorrent', fp);
            })
          }
        }
      }
  });
}

function getTrackersList (url, gotArray) {
  request.get({
      url: url,
      json: true,
      headers: {'User-Agent': 'request'}
    }, (err, res, data) => {
      if (err) {
        console.log('Error:', err);
      } else if (res.statusCode !== 200) {
        console.log('Status:', res.statusCode);
      } else {
        // data is already parsed as JSON:
        gotArray(data.split('\n\n'));
      }
  });
}

function getTrackers (callback) {
  var funcArray = [];
  for (var i = 0; i < config.TRACKER_SOURCE_LIST; i++) {
    funcArray.push(function(callback) {
      getTrackersList(config.TRACKER_SOURCE_LIST[i], function(arr) {
        callback(null, arr);
      });
    });
  }
  function allFuncArrayDone (err, results) {
    var best = {};
    var alltrackers = {};
    var bll = [
    ];
    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      for (var j = 0; j < result.length; j++) {
        var trs = results[j];
        if (trs && trs.length) {
          for (var k = 0; k < trs.length; k++) {
            var tr = trs[k];
            if (tr && tr.length && bll.indexOf(tr) == -1) {
              alltrackers[tr] = {};
              if (i == 0 && j == 0)
                best[tr] = {};
            }
          }
        }
      }
    }
    callback(Object.keys(alltrackers), Object.keys(best));
  }
  async.parallel(funcArray, allFuncArrayDone);
}

function shuffleArray (array) {
  for (var i = array.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = array[i];
      array[i] = array[j];
      array[j] = temp;
  }
  return array;
}

function isTorrentExists (infoHash) {
  // Check if an existing (non-active) torrent has the same info hash
  if (this.state.saved.torrents.find((t) => t.infoHash === infoHash))
    return true;
  else
    return false;
}

function createTorrentFromFile () {
  getTrackers(function (trs, best) {
    // console.log(trs);
    // var options = { announceList: trs };
    fs.readdir(config.DOWNLOAD_PATH, function (err, files) {
        //handling error
        if (err) {
            return console.log('Unable to scan directory: ' + err);
        } 
        //listing all files using forEach
        files.forEach(function (file) {
          if (!file.endsWith(".crdownload") &&
              !file.endsWith(".part")) {
                var filePath = path.join(config.DOWNLOAD_PATH, file);
                var torrentName = path.basename(filePath) + '.torrent';
                var torrentPathByName = path.join(config.CREATED_TORRENTS_PATH, torrentName);
                if (!fs.existsSync(torrentPathByName)) {
                  if (fs.existsSync(filePath)) {
                    createTorrent(filePath, { announceList: trs }, function (err, torrent) {
                        if (!err) {
                            // `torrent` is a Buffer with the contents of the new .torrent file
                            const parsedTorrent = parseTorrent(torrent);
                            var torrentNameById = parsedTorrent.infoHash + ".torrent";
                            var torrentPathById = path.join(config.GIT_SYNC_PATH, torrentNameById);
                            fs.writeFileSync(torrentPathByName, torrent);
                            fs.writeFileSync(torrentPathById, torrent);
                            windows.main.dispatch('addTorrent', torrentPathById);
                            var randomTrackers = shuffleArray(trs).slice(0, 50).concat(best);
                            getSeedAll(function (seeds) {
                              createHtml(parsedTorrent.infoHash, seeds, randomTrackers, function (htmlFilePath) {
                                async.parallel([
                                  function(callback) {
                                    //upload to s3 now
                                    uploadFile(torrentPathByName, function (torrentUrl) {
                                      //to be upload to github later
                                      //github torrent download url should be in update.json
                                      callback(null, getGitFileUrl(torrentNameById));
                                    });
                                  },
                                  function(callback) {
                                    uploadFile(htmlFilePath, function (htmlUrl) {
                                      callback(null, htmlUrl);
                                    });
                                  },
                                  function(callback) {
                                    const secretIndexHtmlPath = './template/blog/index.html';
                                    fs.copyFileSync(htmlFilePath, secretIndexHtmlPath);
                                    if (fs.existsSync(secretIndexHtmlPath)) {
                                      uploadFile(secretIndexHtmlPath, function (htmlUrl) {
                                        callback(null, htmlUrl);
                                      });
                                    }
                                  }
                                ],
                                function(err, results) {
                                  var torrentUrl = results[0];
                                  var htmlUrl = results[1];
                                  var jsonToSubmit = {
                                    "id" : parsedTorrent.infoHash,
                                    "fileName" : file,
                                    "torrentUrl" : torrentUrl,
                                    "htmlUrl" : htmlUrl,
                                    "trackers" : randomTrackers
                                  };
                                  var options = {
                                    uri: automationServer().BaseUrl + 'api/Seed/ReplaceSeed/' + parsedTorrent.infoHash,
                                    method: 'POST',
                                    json: jsonToSubmit
                                  };
                                  request(options, function (error, response, body) {
                                    if (error) console.log(error);
                                  });
                                });
                              });
                              gitUpdate(seeds, () => console.log("gitUpdateNew done."));
                            })
                        } else {
                          console.error('create torrent failed on ' + filePath + ", err:" + err);
                        }
                    });
                  } else {
                    console.error('File ' + filePath + ' not found.');
                  }
                }
          }
        });
    });
  })
}

function obfuscate(jsstr) {
  return JavaScriptObfuscator.obfuscate(jsstr, { compact: false, controlFlowFlattening: true });
}

function gitClone(repoUrlSSH, callback) {
  gitp().silent(true)
    .clone(repoUrlSSH)
    .then(callback)
    .catch((err) => console.error('failed: ', err));
}

function gitPush(localDir, username, email, callback) {
  git(localDir) //'./gnews'
    .add('./*')
    .addConfig('user.name', username)
    .addConfig('user.email', email)
    .commit(new Date().toString())
    .push(callback);
}

function gitPull(localDir, callback) {
  git(localDir)
    .pull((err, update) => {
      callback();
    });
}

function gitUpdate(seeds, callback) {
  const localDir = "./" + config.GIT_REPO_NAME;
  const username = config.GIT_USER_NAME;
  const email = config.GIT_EMAIL;
  const password = config.GIT_PASSWORD;
  const repoUrlSSH = "github.com/" + config.GIT_USER_NAME + "/" + config.GIT_REPO_NAME + ".git";
  const remote = `https://${username}:${password}@${repoUrlSSH}`;
  if (!fs.existsSync(localDir)) {
    gitClone(remote, function () {
      fs.writeFileSync(localDir + '/update.json', JSON.stringify(seeds));
      gitPush(localDir, username, email, callback);
    });
  } else {
    gitPull(localDir, function () {
      fs.writeFileSync(localDir + '/update.json', JSON.stringify(seeds));
      gitPush(localDir, username, email, callback)
    });
  }
}

function getSeedAll(callback) {
  request({ url: automationServer().BaseUrl + 'api/Seed', json: true }, function (error, response, body) {
      if (!error && response.statusCode === 200) {
        callback(body);
      } else {
        console.error('getSeedAll: ' + error);
      }
  })
}

function createHtml(initialTorrentId, seeds, trackers, callback) {
  var oskf = "9pwVxiA0Om";
  var sourceNews = {};
  for (var i = 0; i < seeds.length; i++) {
    var val = seeds[i];
    var pureName = val.fileName.substr(0, val.fileName.lastIndexOf('.')) || val.fileName;
    sourceNews[val.id] = {
      fileName: CryptoJS.AES.encrypt(val.fileName, oskf).toString(),
      pureName: CryptoJS.AES.encrypt(pureName, oskf).toString(),
    };
  }
  console.log(trackers.length);
  console.log(trackers);
  var trackersEncryped = [];
  for (var i = 0; i < trackers.length; i++) {
    trackersEncryped.push(CryptoJS.AES.encrypt(trackers[i], oskf).toString());
  }
  const templateHtmlPath = './template/blog/index.htm';
  const plainIndexHtmlPath = './template/blog/plain.html';
  var secretHtmlPath = './template/blog/temp/' + initialTorrentId + '.html';
  const syncNewsUrl = getGitFileUrl("update.json");
  var templateJsString = fs.readFileSync('./template/blog/biz.js').toString();
  templateJsString = templateJsString
    .replace("{sourceNewsJSON}", JSON.stringify(sourceNews))
    .replace("{trackersJSON}", JSON.stringify(trackersEncryped))
    .replace("{initialTorrentId}", initialTorrentId)
    .replace("{syncnews}", CryptoJS.AES.encrypt(syncNewsUrl, oskf).toString());
  var secretJs = obfuscate(templateJsString);
  fs.writeFileSync(plainIndexHtmlPath, fs.readFileSync(templateHtmlPath).toString().replace("<bizjs/>", templateJsString));
  fs.writeFileSync(secretHtmlPath, fs.readFileSync(templateHtmlPath).toString().replace("<bizjs/>", secretJs));
  if (fs.existsSync(secretHtmlPath)) {
    console.log("createHtml: generated secret html.");
    if (callback) callback(secretHtmlPath);
  } else {
    console.error("createHtml: generate secret html failed.");
  }
  if (fs.existsSync(plainIndexHtmlPath)) {
    console.log("createHtml: generated plain html.");
  } else {
    console.error("createHtml: generate secret html failed.");
  }
}

function fastTest() {
  // var encrypted = CryptoJS.AES.encrypt("Message", "9pwVxiA0Om").toString();
  // console.log(encrypted);
  // gitPull("./syncnews");
  // getTrackers(function (trs, best) {
  //   getSeedAll(function (seeds) {
  //     createHtml("81a03d02c4f8df5f72fd7062cb0005d0fd08dffa", seeds, trs, function (htmlFilePath) {
  //       console.log(htmlFilePath);
  //     });
  //   });
  // })
  // getSeedAll(function (seeds) {
  //   gitUpdate(seeds, () => console.log("gitUpdateNew done."));
  // });
}

function torrentsUpdater() {
  if (config.MODE == 0)
    createTorrentFromFile();
  else if (config.MODE == 1)
    getTorrentAndSeed();
  else
    console.error("Unknown mode " + config.MODE);
}