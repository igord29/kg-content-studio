import cv2, json, sys
sys.path.insert(0,'.')
from det import people
cap=cv2.VideoCapture('r10/r10.mp4'); fps=cap.get(5); i=0; R=[]
while True:
    ok=cap.grab()
    if not ok: break
    if i%5==0:
        ok,f=cap.retrieve(); R.append([round(i/fps,3),people(f,w=1024)])
    i+=1
json.dump(R,open('r10/t_r10.json','w')); print('done',len(R))
