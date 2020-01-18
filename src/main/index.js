console.time('init')

const electron = require('electron')
const app = electron.app

const parallel = require('run-parallel')
const request = require('request')
const createTorrent = require('create-torrent')
const parseTorrent = require('parse-torrent')
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

  setInterval(torrentsUpdater, 10 * 1000)
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
        Body: fileContent
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

function getTorrentAndSeed () {
  var url = 'http://graph.facebook.com/517267866/?fields=picture';
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
        console.log(data.picture.data.url);
      }
  });
}

function isTorrentExists (infoHash) {
  // Check if an existing (non-active) torrent has the same info hash
  if (this.state.saved.torrents.find((t) => t.infoHash === infoHash))
    return true;
  else
    return false;
}

function createTorrentFromFile () {
  var options = {
      announceList: [
          "udp://tracker.coppersurfer.tk:6969/announce",
          "udp://tracker.leechers-paradise.org:6969/announce",
          "udp://tracker.opentrackr.org:1337/announce",
          "udp://tracker.internetwarriors.net:1337/announce",
          "udp://p4p.arenabg.com:1337/announce",
          "udp://9.rarbg.to:2710/announce",
          "udp://9.rarbg.me:2710/announce",
          "udp://exodus.desync.com:6969/announce",
          "udp://tracker.tiny-vps.com:6969/announce",
          "udp://tracker.moeking.me:6969/announce",
          "udp://retracker.lanta-net.ru:2710/announce",
          "udp://open.stealth.si:80/announce",
          "udp://open.demonii.si:1337/announce",
          "udp://denis.stalker.upeer.me:6969/announce",
          "udp://tracker.torrent.eu.org:451/announce",
          "udp://tracker.cyberia.is:6969/announce",
          "udp://tracker4.itzmx.com:2710/announce",
          "udp://tracker3.itzmx.com:6961/announce",
          "udp://ipv4.tracker.harry.lu:80/announce",
          "udp://explodie.org:6969/announce",
          "http://explodie.org:6969/announce",
          "udp://zephir.monocul.us:6969/announce",
          "udp://xxxtor.com:2710/announce",
          "udp://valakas.rollo.dnsabr.com:2710/announce",
          "udp://tracker.zum.bi:6969/announce",
          "udp://tracker.yoshi210.com:6969/announce",
          "udp://tracker.uw0.xyz:6969/announce",
          "udp://tracker.sbsub.com:2710/announce",
          "udp://tracker.nyaa.uk:6969/announce",
          "udp://tracker.nextrp.ru:6969/announce",
          "udp://tracker.lelux.fi:6969/announce",
          "udp://tracker.iamhansen.xyz:2000/announce",
          "udp://tracker.filemail.com:6969/announce",
          "udp://tracker.dler.org:6969/announce",
          "udp://tracker-udp.gbitt.info:80/announce",
          "udp://retracker.sevstar.net:2710/announce",
          "udp://retracker.netbynet.ru:2710/announce",
          "udp://retracker.akado-ural.ru:80/announce",
          "udp://opentor.org:2710/announce",
          "udp://open.nyap2p.com:6969/announce",
          "udp://bt2.archive.org:6969/announce",
          "udp://bt1.archive.org:6969/announce",
          "udp://bt.okmp3.ru:2710/announce",
          "https://tracker.nanoha.org:443/announce",
          "http://www.proxmox.com:6969/announce",
          "http://tracker.opentrackr.org:1337/announce",
          "http://tracker.bt4g.com:2095/announce",
          "http://t.nyaatracker.com:80/announce",
          "http://retracker.sevstar.net:2710/announce",
          "http://mail2.zelenaya.net:80/announce",
          "http://h4.trakx.nibba.trade:80/announce",
          "udp://tracker2.itzmx.com:6961/announce",
          "udp://tracker.zerobytes.xyz:1337/announce",
          "udp://tr.bangumi.moe:6969/announce",
          "udp://qg.lorzl.gq:2710/announce",
          "udp://opentracker.i2p.rocks:6969/announce",
          "udp://chihaya.toss.li:9696/announce",
          "udp://bt2.54new.com:8080/announce",
          "https://tracker.parrotlinux.org:443/announce",
          "https://tracker.opentracker.se:443/announce",
          "https://tracker.lelux.fi:443/announce",
          "https://tracker.gbitt.info:443/announce",
          "http://www.loushao.net:8080/announce",
          "http://vps02.net.orel.ru:80/announce",
          "http://tracker4.itzmx.com:2710/announce",
          "http://tracker3.itzmx.com:6961/announce",
          "http://tracker2.itzmx.com:6961/announce",
          "http://tracker1.itzmx.com:8080/announce",
          "http://tracker01.loveapp.com:6789/announce",
          "http://tracker.zerobytes.xyz:1337/announce",
          "http://tracker.yoshi210.com:6969/announce",
          "http://tracker.torrentyorg.pl:80/announce",
          "http://tracker.nyap2p.com:8080/announce",
          "http://tracker.lelux.fi:80/announce",
          "http://tracker.internetwarriors.net:1337/announce",
          "http://tracker.gbitt.info:80/announce",
          "http://tracker.bz:80/announce",
          "http://pow7.com:80/announce",
          "http://opentracker.i2p.rocks:6969/announce",
          "http://open.acgtracker.com:1096/announce",
          "http://open.acgnxtracker.com:80/announce"
      ]
  };
  fs.readdir(config.SEEDING_FILES_PATH, function (err, files) {
      //handling error
      if (err) {
          return console.log('Unable to scan directory: ' + err);
      } 
      //listing all files using forEach
      files.forEach(function (file) {
        var filePath = path.join(config.SEEDING_FILES_PATH, file);
        var torrentName = path.basename(filePath) + '.torrent';
        var torrentPath = path.join(config.CREATED_TORRENTS_PATH, torrentName);
        if (!fs.existsSync(torrentPath)) {
          if (fs.existsSync(filePath)) {
            createTorrent(filePath, options, function (err, torrent) {
                if (!err) {
                    // `torrent` is a Buffer with the contents of the new .torrent file
                    fs.writeFileSync(torrentPath, torrent);
                    windows.main.dispatch('addTorrent', torrentPath);
                    uploadFile(torrentPath, function (torrentUrl) {
                      const parsedTorrent = parseTorrent(torrent);
                      parsedTorrent.announce = options.announceList;
                      console.log(parsedTorrent.infoHash);
                      console.log(parseTorrent.toMagnetURI(parsedTorrent));
                    });
                } else {
                  console.error('create torrent failed on ' + filePath + ", err:" + err);
                }
            });
          } else {
            console.error('File ' + filePath + ' not found.');
          }
        }
      });
  });
}

function torrentsUpdater () {
  // console.log(config.SEEDING_FILES_PATH);
  // windows.main.dispatch('addTorrent', "E:/webtorrent-desktop/seeding_files/")
  createTorrentFromFile();
  // getTorrentAndSeed();
}